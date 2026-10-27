import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('deployment', ROOT/'Provision-Instances.py')
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)

class CompanyDeploymentTests(unittest.TestCase):
    def rows(self):
        return [{'uuid': '00000000-0000-4000-8000-00000000000'+str(i), 'name':'Company '+str(i)} for i in range(1,7)]

    def test_separate_storage_projects_routes_and_ports(self):
        plan=deployment.plan_instances(self.rows(),'erp.trusoft.ai')
        for key in ['project','baseUrl','webroot','httpPort','mailpitPort']:
            self.assertEqual(len({item[key] for item in plan}),6)
        self.assertEqual(len({item[key] for item in plan for key in ['httpPort','mailpitPort']}),12)
        self.assertTrue(all(item['baseUrl'].startswith('https://erp.trusoft.ai/signing/') for item in plan))

    def test_invalid_host_and_port_fail_before_preparation(self):
        for host in ['example.org; return 200;', 'https://example.org', 'x\ninclude bad;', '']:
            with self.assertRaises(ValueError): deployment.plan_instances(self.rows(),host)
        for port in [80,65530]:
            with self.assertRaises(ValueError): deployment.plan_instances(self.rows(),'erp.trusoft.ai',port)

    def test_registry_rejects_duplicate_archived_or_zero_tenants(self):
        with tempfile.TemporaryDirectory() as temporary:
            file=pathlib.Path(temporary)/'registry.json'
            for rows in [[self.rows()[0],self.rows()[0]], [{'uuid':'00000000-0000-0000-0000-000000000000','name':'Zero'}], [{**self.rows()[0],'archivedAt':'2026-01-01'}]]:
                file.write_text(json.dumps(rows))
                with self.assertRaises(ValueError): deployment.registry_from(file)

    def test_rerun_preserves_secrets_and_rejects_reassignment(self):
        with tempfile.TemporaryDirectory() as temporary:
            source=pathlib.Path(temporary)/'templates'
            source.mkdir()
            (source/'.runtime').mkdir()
            for file in deployment.FILES+['libresignClient.mjs']:
                (source/file).write_text('template')
            (source/'.runtime/synthetic-offer.pdf').write_bytes(b'%PDF synthetic fixture')
            root=pathlib.Path(temporary)/'companies'
            plan=deployment.plan_instances(self.rows(),'erp.trusoft.ai')
            with patch.object(deployment,'port_available',return_value=True):
                deployment.prepare(source,root,plan)
            secret=root/plan[0]['tenantId']/'.secrets'
            secret.mkdir()
            (secret/'admin_password').write_text('preserve-existing-secret')
            with patch.object(deployment,'port_available',side_effect=AssertionError('Existing installations must retain their bound ports')):
                deployment.prepare(source,root,plan)
            self.assertEqual((secret/'admin_password').read_text(),'preserve-existing-secret')
            self.assertEqual(json.loads((root/'instances.json').read_text()),plan)
            changed=[{**plan[0],'httpPort':5500},*plan[1:]]
            with self.assertRaises(ValueError): deployment.prepare(source,root,changed)

    def test_port_conflict_does_not_create_any_company_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=pathlib.Path(temporary)/'companies'
            plan=deployment.plan_instances(self.rows(),'erp.trusoft.ai')
            with patch.object(deployment,'port_available',side_effect=[True,True,False]):
                with self.assertRaises(ValueError): deployment.prepare(ROOT,root,plan)
            self.assertEqual(list(root.iterdir()),[])

if __name__=='__main__': unittest.main()
