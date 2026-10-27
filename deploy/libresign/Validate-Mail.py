#!/usr/bin/env python3
"""Validate and install one company's protected Nextcloud SMTP settings."""
import json, os, pathlib, re, stat, sys

def validate_file(filename):
    path=pathlib.Path(filename)
    if not path.is_file() or path.is_symlink(): raise ValueError('SMTP settings must be a regular protected file')
    if os.name!='nt' and stat.S_IMODE(path.stat().st_mode) & 0o037:
        raise ValueError('SMTP source must not be writable by its group or accessible to other users')
    settings=json.loads(path.read_text())
    required={'mail_smtphost','mail_smtpport','mail_smtpsecure','mail_smtpauth','mail_smtpname','mail_smtppassword','mail_from_address','mail_domain'}
    if set(settings)!=required: raise ValueError('Supply exactly the documented SMTP settings')
    if not isinstance(settings['mail_smtphost'],str) or not re.fullmatch(r'[a-zA-Z0-9.-]+',settings['mail_smtphost']) or settings['mail_smtphost']=='mailpit':
        raise ValueError('A production SMTP hostname is required')
    if (settings['mail_smtpport'],settings['mail_smtpsecure']) not in [(465,'ssl'),(587,'')]:
        raise ValueError('Use port 465 with ssl or port 587 with automatic STARTTLS')
    if settings['mail_smtpauth'] is not True: raise ValueError('Each company requires authenticated SMTP')
    for key in ['mail_smtpname','mail_smtppassword']:
        if not isinstance(settings[key],str) or not settings[key] or any(ord(c)<32 for c in settings[key]):
            raise ValueError('Authenticated SMTP requires valid protected credentials')
    if not re.fullmatch(r'[a-zA-Z0-9._+-]+',str(settings['mail_from_address'])) or not re.fullmatch(r'[a-zA-Z0-9.-]+',str(settings['mail_domain'])):
        raise ValueError('A valid company sender address is required')
    settings['mail_smtpmode']='smtp'
    settings['mail_smtpauthtype']='LOGIN'
    return settings

def install(source):
    settings=validate_file(source)
    path=pathlib.Path('.secrets/smtp-settings.json')
    temporary=path.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(settings))
    temporary.chmod(0o640)
    temporary.replace(path)

if __name__=='__main__':
    try: install(sys.argv[1])
    except (ValueError,TypeError,KeyError,OSError):
        raise SystemExit('SMTP configuration is invalid or inaccessible; check the protected file and documented schema') from None
