#!/usr/bin/env python3
"""Apply distinct company senders after TLS and SMTP authentication checks; sends no email."""
import argparse, datetime, importlib.util, json, os, pathlib, smtplib, ssl, subprocess
ROOT=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('mail_settings',ROOT/'Validate-Mail.py')
mail_settings=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mail_settings)

def verify_transport(settings):
    context=ssl.create_default_context()
    if settings['mail_smtpport']==465:
        client=smtplib.SMTP_SSL(settings['mail_smtphost'],465,timeout=20,context=context)
    else:
        client=smtplib.SMTP(settings['mail_smtphost'],587,timeout=20)
    with client:
        client.ehlo()
        if settings['mail_smtpport']==587:
            client.starttls(context=context)
            client.ehlo()
        client.login(settings['mail_smtpname'],settings['mail_smtppassword'])

def validated_bindings(root, mapping):
    plan=json.loads((root/'instances.json').read_text())
    tenants={entry['tenantId']:entry for entry in plan}
    if not isinstance(mapping,list) or len(mapping)!=len(tenants):
        raise ValueError('Supply one sender settings file for every managed company')
    seen=set(); senders=set(); bindings=[]
    for item in mapping:
        if not isinstance(item,dict) or item.get('tenantId') in seen or item.get('tenantId') not in tenants:
            raise ValueError('Company mapping is invalid or duplicated')
        if set(item) not in ({'tenantId','settingsFile'},{'tenantId','mailMode'}):
            raise ValueError('Company mapping is invalid or duplicated')
        tenant=item['tenantId']; entry=tenants[tenant]
        folder=root/tenant
        if folder.resolve().parent!=root or json.loads((folder/'.runtime/instance.json').read_text())!=entry:
            raise ValueError('Company installation identity does not match the registry')
        seen.add(tenant)
        if 'mailMode' in item:
            if item['mailMode'] not in ('NO_EMAIL','TEMPORARY'): raise ValueError('Invalid company mail mode')
            bindings.append((entry,folder,None,{'mailMode':item['mailMode']},None))
            continue
        path=pathlib.Path(item['settingsFile'])
        if not path.is_absolute(): raise ValueError('SMTP settings file must use an absolute protected path')
        settings=mail_settings.validate_file(path)
        sender=(settings['mail_from_address']+'@'+settings['mail_domain']).lower()
        if sender in senders: raise ValueError('Each company must use its own sender')
        seen.add(tenant); senders.add(sender)
        bindings.append((entry,folder,path,settings,sender))
    return bindings

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mapping',help='Protected JSON array of tenantId and absolute settingsFile')
    parser.add_argument('--root',required=True)
    args=parser.parse_args()
    if os.geteuid()!=0: raise SystemExit('Run as root')
    os.umask(0o077)
    root=pathlib.Path(args.root).resolve()
    bindings=validated_bindings(root,json.loads(pathlib.Path(args.mapping).read_text()))
    for entry,folder,path,settings,sender in bindings:
        if path is None: continue
        verify_transport(settings)
        print('TLS and SMTP authentication verified for '+entry['companyName'],flush=True)
    report=[]
    for entry,folder,path,settings,sender in bindings:
        if path is not None:
            subprocess.run(['bash','Configure-Mail.sh',str(path)],cwd=folder,check=True,timeout=240)
        report.append({'tenantId':entry['tenantId'],'companyName':entry['companyName'],'sender':sender,
                       'mailMode':'SMTP' if path is not None else settings['mailMode'],
                       'transportAuthenticated':path is not None,'deliveryVerified':False,
                       'configuredAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
        target=root/'.runtime/company-mail.json'
        temporary=target.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(report,indent=2)+'\n'); temporary.chmod(0o600); temporary.replace(target)
    print('Requested company senders applied; companies without email remain excluded from production signing bindings. No email was sent.')

if __name__=='__main__':
    try: main()
    except (ValueError,TypeError,KeyError,OSError,smtplib.SMTPException,subprocess.SubprocessError):
        raise SystemExit('Company mail setup failed. Check protected settings and service health; credentials and SMTP responses were withheld.') from None
