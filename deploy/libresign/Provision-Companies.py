#!/usr/bin/env python3
"""Provision isolated requestors from an authoritative active-company export."""
import argparse, json, os, pathlib, subprocess, uuid

def companies_from(path):
    rows = json.loads(pathlib.Path(path).read_text())
    if not isinstance(rows, list) or not rows:
        raise ValueError('Expected a nonempty active-company array')
    seen = set()
    for row in rows:
        company = str(uuid.UUID(row['uuid']))
        name = row['name']
        if company != row['uuid'] or uuid.UUID(company).int == 0 or company in seen:
            raise ValueError('Company UUID must be canonical, nonzero and unique')
        if row.get('archivedAt') is not None:
            raise ValueError('Archived companies must not be provisioned')
        if not isinstance(name, str) or not name.strip() or len(name) > 160 or any(ord(c) < 32 for c in name):
            raise ValueError('Invalid company name')
        seen.add(company)
    return rows

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('registry', help='Protected JSON exported from the authoritative company registry')
    parser.add_argument('--base-url', default='https://erp.trusoft.ai/libresign')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run as root to protect company credentials')
    os.umask(0o077)
    root = pathlib.Path(__file__).resolve().parent
    rows = companies_from(args.registry)  # Validate the whole batch before any writes.
    report = []
    for row in rows:
        subprocess.run(['bash', str(root/'Provision-Tenant.sh'), row['uuid'], row['name'], args.base_url], cwd=root, check=True)
        report.append({'tenantId':row['uuid'], 'companyName':row['name'], 'baseUrl':args.base_url, 'requestor':'erp-recruitment-'+row['uuid'], 'provisioned':True})
    output = root/'.runtime/company-provisioning.json'
    temporary = output.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(report, indent=2)+'\n')
    temporary.replace(output)
    print('Verified company accounts provisioned: '+str(len(report)))

if __name__ == '__main__':
    main()
