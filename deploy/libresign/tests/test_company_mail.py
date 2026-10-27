import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch, MagicMock

ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('company_mail',ROOT/'Configure-CompanyMail.py')
mail=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail)

class CompanyMailTests(unittest.TestCase):
    def settings(self,local='recruitment'):
        return dict(mail_smtphost='smtp.example.invalid',mail_smtpport=465,mail_smtpsecure='ssl',mail_smtpauth=True,
                    mail_smtpname=local+'@example.invalid',mail_smtppassword='fixture-only',mail_from_address=local,mail_domain='example.invalid')

    def test_rejects_test_mailbox_missing_credentials_and_invalid_tls(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=pathlib.Path(temporary)/'smtp.json'
            for changes in [{'mail_smtphost':'mailpit'},{'mail_smtpauth':False},{'mail_smtppassword':''},{'mail_smtpport':587,'mail_smtpsecure':'ssl'}]:
                path.write_text(json.dumps({**self.settings(),**changes}));path.chmod(0o600)
                with self.assertRaises(ValueError): mail.mail_settings.validate_file(path)
            path.write_text(json.dumps(self.settings()));path.chmod(0o600)
            self.assertEqual(mail.mail_settings.validate_file(path)['mail_smtpmode'],'smtp')

    def test_requires_exact_company_coverage_and_distinct_senders(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=pathlib.Path(temporary)
            plan=[{'tenantId':'company-a'},{'tenantId':'company-b'}]
            (root/'instances.json').write_text(json.dumps(plan))
            mapping=[]
            for entry in plan:
                folder=root/entry['tenantId'];(folder/'.runtime').mkdir(parents=True)
                (folder/'.runtime/instance.json').write_text(json.dumps(entry))
                path=root/(entry['tenantId']+'.json');path.write_text(json.dumps(self.settings()));path.chmod(0o600)
                mapping.append({'tenantId':entry['tenantId'],'settingsFile':str(path)})
            with self.assertRaises(ValueError): mail.validated_bindings(root,mapping[:1])
            with self.assertRaises(ValueError): mail.validated_bindings(root,mapping)
            pathlib.Path(mapping[1]['settingsFile']).write_text(json.dumps(self.settings('second-company')))
            result=mail.validated_bindings(root,mapping)
            self.assertEqual(len(result),2)
            self.assertNotEqual(result[0][-1],result[1][-1])
            mapping[1]={'tenantId':'company-b','mailMode':'NO_EMAIL'}
            result=mail.validated_bindings(root,mapping)
            self.assertIsNone(result[1][2]);self.assertIsNone(result[1][-1])
            mapping[1]['mailMode']='TEMPORARY'
            self.assertEqual(mail.validated_bindings(root,mapping)[1][3]['mailMode'],'TEMPORARY')
            mapping[1]['mailMode']='unknown'
            with self.assertRaises(ValueError):mail.validated_bindings(root,mapping)

    def test_production_binding_requires_authenticated_smtp_and_excludes_no_email(self):
        spec=importlib.util.spec_from_file_location('hr_binding',ROOT/'Configure-HrBinding.py')
        binding=importlib.util.module_from_spec(spec);spec.loader.exec_module(binding)
        rows=[{'uuid':'a'},{'uuid':'b'},{'uuid':'c'}]
        report=[{'tenantId':'a','mailMode':'SMTP','transportAuthenticated':True},
                {'tenantId':'b','mailMode':'NO_EMAIL'},{'tenantId':'c','mailMode':'TEMPORARY'}]
        self.assertEqual(binding.production_mail_tenants(rows,report),{'a'})
        with self.assertRaises(ValueError):binding.production_mail_tenants(rows,report[:1])
        report[0]['transportAuthenticated']=False
        with self.assertRaises(ValueError):binding.production_mail_tenants(rows,report)

    def test_transport_authenticates_only_after_tls_and_never_sends(self):
        client=MagicMock();client.__enter__.return_value=client
        settings={**self.settings(),'mail_smtpport':587,'mail_smtpsecure':''}
        with patch.object(mail.smtplib,'SMTP',return_value=client): mail.verify_transport(settings)
        calls=[call[0] for call in client.mock_calls]
        self.assertLess(calls.index('starttls'),calls.index('login'))
        client.sendmail.assert_not_called();client.send_message.assert_not_called()
        client=MagicMock();client.__enter__.return_value=client;client.starttls.side_effect=RuntimeError('TLS unavailable')
        with patch.object(mail.smtplib,'SMTP',return_value=client):
            with self.assertRaises(RuntimeError): mail.verify_transport(settings)
        client.login.assert_not_called()

if __name__=='__main__': unittest.main()
