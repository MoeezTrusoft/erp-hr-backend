#!/usr/bin/env python3
"""Recover the five existing installations using cloned data; never start Docker.

Run as root on erptrusoft. prepare is non-destructive and must precede deploy.
Secrets and manifests stay in root-only server directories. No mail is sent.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

COMPANIES = {
    'trusoft': '40314ef4-0a81-4390-b631-b3ad3f21f523',
    'boc': '14d8c7b1-194d-4e35-b058-b9cb9aa9fba2',
    'homevision': '61b7eb53-ab6e-413f-9d9a-1ecf4e071e73',
    'homenet': '8ff0533b-62f6-4be9-a78e-69adf49e00bc',
    'joc': '8f4a526f-d45b-4da2-b772-d6682e849812',
}
PORTS = {'trusoft': 5400, 'homenet': 5402, 'joc': 5404, 'boc': 5406, 'homevision': 5408}
ROOT = Path('/opt/erp-cicd/recruitment-signing-k8s/companies')
DATA = Path('/var/lib/erp-recruitment-signing')
SOURCE = Path('/home/erp_trusoft/recruitment-libresign-companies')
NGINX = Path('/etc/nginx/snippets/recruitment-libresign-companies.conf')
DB_IMAGE = 'docker.io/library/postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'
REDIS_IMAGE = 'docker.io/library/redis:7.4-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499'
MAIL_IMAGE = 'docker.io/axllent/mailpit:latest@sha256:23fe39e81bde596a918000b3135c0f85dc8bb4c9ea6be274b051143f3e300387'


def run(args, capture=False, check=True):
    return subprocess.run(args, check=check, text=True, capture_output=capture)


def kubectl(*args, capture=False):
    return run(['kubectl', *args], capture=capture)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(json.dumps(value, indent=2) if not isinstance(value, str) else value)
    os.chmod(path, 0o600)


def require_stopped():
    for unit in ('docker.service', 'docker.socket'):
        state = run(['systemctl', 'is-active', unit], capture=True, check=False).stdout.strip()
        if state in ('active', 'activating'):
            raise RuntimeError('Docker must remain stopped before copying its volumes')
    if list(Path('/sys/fs/cgroup/system.slice').glob('docker-*.scope')):
        raise RuntimeError('Docker container processes still exist')


def digest_tree(path):
    """Content manifest also detects changed paths, modes, owners and symlinks."""
    result = hashlib.sha256()
    count = total = 0
    for parent, dirs, files in os.walk(path):
        dirs.sort()
        for name in sorted(dirs + files):
            item = Path(parent) / name
            st = item.lstat()
            result.update(json.dumps([str(item.relative_to(path)), st.st_mode, st.st_uid, st.st_gid]).encode())
            if item.is_symlink():
                result.update(os.readlink(item).encode())
            elif item.is_file():
                count += 1
                total += st.st_size
                with item.open('rb') as stream:
                    while chunk := stream.read(1024 * 1024):
                        result.update(chunk)
    return {'sha256': result.hexdigest(), 'files': count, 'bytes': total}


def prepare(name):
    require_stopped()
    cid = COMPANIES[name]
    work = ROOT / cid
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    marker = work / 'copy-verified.json'
    if marker.exists():
        print(name + ': existing verified clone retained')
        return
    if (DATA / cid).exists():
        raise RuntimeError('Unverified destination exists; inspect it before retrying')
    DATA.mkdir(parents=True, exist_ok=True, mode=0o711)
    (DATA / cid).mkdir(mode=0o711)
    evidence = {'companyId': cid, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'volumes': {}}
    for volume in ('database', 'nextcloud', 'redis'):
        source = Path('/var/lib/docker/volumes') / ('recruitment-sign-' + cid + '_' + volume) / '_data'
        if not source.is_dir():
            raise RuntimeError('Required original volume is missing: ' + volume)
        target = DATA / cid / volume
        target.mkdir(mode=0o700)
        run(['rsync', '-aHAX', '--numeric-ids', str(source) + '/', str(target) + '/'])
        original = digest_tree(source)
        copied = digest_tree(target)
        if original != copied:
            raise RuntimeError('Clone verification failed: ' + volume)
        evidence['volumes'][volume] = original
        print(name + ': verified ' + volume, flush=True)
    # A crash-stopped postgres PID belongs to the old container, never the new one.
    pid = DATA / cid / 'database' / 'postmaster.pid'
    if pid.exists():
        shutil.copy2(pid, work / 'original-postmaster.pid')
        pid.unlink()
    save(marker, evidence)


def resource(kind, name, namespace=None, **kwargs):
    api = {'Namespace': 'v1', 'PersistentVolume': 'v1', 'PersistentVolumeClaim': 'v1',
           'Secret': 'v1', 'Service': 'v1', 'Deployment': 'apps/v1', 'NetworkPolicy': 'networking.k8s.io/v1'}[kind]
    meta = {'name': name}
    if namespace:
        meta['namespace'] = namespace
    return {'apiVersion': api, 'kind': kind, 'metadata': meta, **kwargs}


def manifest(name, image):
    cid = COMPANIES[name]
    ns = 'sign-' + name
    work = ROOT / cid
    if not (work / 'copy-verified.json').exists():
        raise RuntimeError('Verified clone required first')
    if not re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}', image):
        raise RuntimeError('An immutable image reference is required')
    result = [resource('Namespace', ns)]
    for volume, capacity in [('database', '10Gi'), ('nextcloud', '20Gi'), ('redis', '2Gi')]:
        pv = ns + '-' + volume
        result.append(resource('PersistentVolume', pv, spec={
            'capacity': {'storage': capacity}, 'volumeMode': 'Filesystem',
            'accessModes': ['ReadWriteOnce'], 'persistentVolumeReclaimPolicy': 'Retain',
            'storageClassName': '', 'claimRef': {'namespace': ns, 'name': volume},
            'local': {'path': str(DATA / cid / volume)},
            'nodeAffinity': {'required': {'nodeSelectorTerms': [{'matchExpressions': [
                {'key': 'kubernetes.io/hostname', 'operator': 'In', 'values': ['erptrusoft']}]}]}}}))
        result.append(resource('PersistentVolumeClaim', volume, ns, spec={
            'accessModes': ['ReadWriteOnce'], 'storageClassName': '', 'volumeName': pv,
            'resources': {'requests': {'storage': capacity}}}))
    secret = {}
    for key in ('database_password', 'admin_password', 'integration_password'):
        secret[key] = base64.b64encode((SOURCE / cid / '.secrets' / key).read_bytes()).decode()
    production = name in ('trusoft', 'boc', 'homevision')
    if production:
        secret['smtp_settings'] = base64.b64encode((SOURCE / cid / '.secrets/smtp-settings.json').read_bytes()).decode()
        secret['mail_config'] = base64.b64encode((SOURCE / cid / 'mail.config.php').read_bytes()).decode()
    result.append(resource('Secret', 'runtime', ns, type='Opaque', data=secret))
    dns = {'to': [{'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'kube-system'}}}],
           'ports': [{'protocol': protocol, 'port': 53} for protocol in ('TCP', 'UDP')]}
    result.append(resource('NetworkPolicy', 'isolate-company', ns, spec={
        'podSelector': {}, 'policyTypes': ['Ingress', 'Egress'],
        'ingress': [{'from': [{'podSelector': {}}]}],
        'egress': [{'to': [{'podSelector': {}}]}, dns]}))
    result.append(resource('NetworkPolicy', 'host-proxy', ns, spec={
        'podSelector': {'matchLabels': {'app': 'app'}}, 'policyTypes': ['Ingress'],
        'ingress': [{'from': [{'ipBlock': {'cidr': ip}} for ip in ('192.168.88.171/32', '10.42.0.1/32', '127.0.0.1/32')],
                     'ports': [{'protocol': 'TCP', 'port': 80}]}]}))
    result.append(resource('NetworkPolicy', 'signing-egress', ns, spec={
        'podSelector': {'matchExpressions': [{'key': 'app', 'operator': 'In', 'values': ['app', 'cron']}]},
        'policyTypes': ['Egress'], 'egress': [{'to': [{'ipBlock': {'cidr': '0.0.0.0/0',
            'except': ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8']}}],
            'ports': [{'protocol': 'TCP', 'port': p} for p in ([443, 465, 587] if production else [443])]}]}))
    mounts = [{'name': 'nextcloud', 'mountPath': '/var/www/html'}, {'name': 'runtime', 'mountPath': '/run/secrets', 'readOnly': True}]
    if production:
        mounts.append({'name': 'runtime', 'subPath': 'mail_config', 'mountPath': '/var/www/html/config/recruitment-mail.config.php', 'readOnly': True})
    env = {
        'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'POSTGRES_HOST': 'db',
        'POSTGRES_DB': 'libresign', 'POSTGRES_USER': 'libresign',
        'POSTGRES_PASSWORD_FILE': '/run/secrets/database_password',
        'NEXTCLOUD_ADMIN_USER': 'recruitment-admin', 'NEXTCLOUD_ADMIN_PASSWORD_FILE': '/run/secrets/admin_password',
        'NEXTCLOUD_TRUSTED_DOMAINS': 'erp.trusoft.ai 127.0.0.1 localhost app',
        'OVERWRITEHOST': 'erp.trusoft.ai', 'OVERWRITEPROTOCOL': 'https',
        'OVERWRITEWEBROOT': '/signing/' + cid, 'OVERWRITECLIURL': 'https://erp.trusoft.ai/signing/' + cid,
        'REDIS_HOST': 'redis', 'SMTP_HOST': '' if production else 'mailpit',
        'SMTP_PORT': '1025', 'MAIL_FROM_ADDRESS': 'recruitment', 'MAIL_DOMAIN': 'example.test',
        'PHP_MEMORY_LIMIT': '1024M', 'PHP_UPLOAD_LIMIT': '16M',
    }

    def deploy(app, container, volumes, replicas=1):
        labels = {'app': app, 'company': name}
        result.append(resource('Deployment', app, ns, spec={
            'replicas': replicas, 'strategy': {'type': 'Recreate'}, 'selector': {'matchLabels': labels},
            'template': {'metadata': {'labels': labels}, 'spec': {
                'automountServiceAccountToken': False, 'nodeSelector': {'kubernetes.io/hostname': 'erptrusoft'},
                'terminationGracePeriodSeconds': 60, 'containers': [container], 'volumes': volumes}}}))

    def service(app, port):
        result.append(resource('Service', app, ns, spec={'selector': {'app': app},
                      'ports': [{'port': port, 'targetPort': port, 'protocol': 'TCP'}]}))

    def storage(volume):
        return {'name': volume, 'persistentVolumeClaim': {'claimName': volume}}

    secret_volume = {'name': 'runtime', 'secret': {'secretName': 'runtime', 'defaultMode': 292}}
    deploy('db', {'name': 'db', 'image': DB_IMAGE, 'imagePullPolicy': 'IfNotPresent',
        'env': [{'name': k, 'value': v} for k, v in {'POSTGRES_DB': 'libresign', 'POSTGRES_USER': 'libresign', 'POSTGRES_PASSWORD_FILE': '/run/secrets/database_password'}.items()],
        'volumeMounts': [{'name': 'database', 'mountPath': '/var/lib/postgresql/data'}, {'name': 'runtime', 'mountPath': '/run/secrets', 'readOnly': True}],
        'resources': {'requests': {'cpu': '50m', 'memory': '128Mi'}, 'limits': {'cpu': '1', 'memory': '768Mi'}},
        'readinessProbe': {'exec': {'command': ['pg_isready', '-U', 'libresign', '-d', 'libresign']}, 'periodSeconds': 10},
        'startupProbe': {'exec': {'command': ['pg_isready', '-U', 'libresign', '-d', 'libresign']}, 'failureThreshold': 60, 'periodSeconds': 5}},
        [storage('database'), secret_volume])
    service('db', 5432)
    deploy('redis', {'name': 'redis', 'image': REDIS_IMAGE, 'imagePullPolicy': 'IfNotPresent',
        'args': ['redis-server', '--appendonly', 'yes'],
        'volumeMounts': [{'name': 'redis', 'mountPath': '/data'}],
        'resources': {'requests': {'cpu': '25m', 'memory': '32Mi'}, 'limits': {'cpu': '500m', 'memory': '256Mi'}},
        'readinessProbe': {'exec': {'command': ['redis-cli', 'ping']}, 'periodSeconds': 10}}, [storage('redis')])
    service('redis', 6379)
    if not production:
        deploy('mailpit', {'name': 'mailpit', 'image': MAIL_IMAGE, 'imagePullPolicy': 'IfNotPresent',
            'resources': {'requests': {'cpu': '10m', 'memory': '32Mi'}, 'limits': {'cpu': '250m', 'memory': '128Mi'}}}, [])
        service('mailpit', 1025)
    for app in ('app', 'cron'):
        container = {'name': app, 'image': image, 'imagePullPolicy': 'Never',
            'env': [{'name': k, 'value': v} for k, v in env.items()], 'volumeMounts': mounts,
            'resources': {'requests': {'cpu': '100m' if app == 'app' else '25m', 'memory': '256Mi' if app == 'app' else '64Mi'},
                          'limits': {'cpu': '2' if app == 'app' else '1', 'memory': '1536Mi' if app == 'app' else '768Mi'}}}
        if app == 'cron':
            container['command'] = ['/cron.sh']
            container['env'] = [{**item, 'value': '512M'} if item['name'] == 'PHP_MEMORY_LIMIT' else item for item in container['env']]
        else:
            probe = {'httpGet': {'path': '/status.php', 'port': 80, 'httpHeaders': [{'name': 'Host', 'value': 'erp.trusoft.ai'}]}, 'timeoutSeconds': 5, 'periodSeconds': 10}
            container['readinessProbe'] = probe
            container['startupProbe'] = {**probe, 'failureThreshold': 60}
        deploy(app, container, [storage('nextcloud'), secret_volume], 1 if app == 'app' else 0)
    service('app', 80)
    path = work / 'manifest.json'
    save(path, {'apiVersion': 'v1', 'kind': 'List', 'items': result})
    return path


def deploy_company(name, image):
    path = manifest(name, image)
    kubectl('apply', '-f', str(path), '--dry-run=client', '-o', 'name')
    # Create the namespace first so admission can validate the namespaced objects.
    ns_path = ROOT / COMPANIES[name] / 'namespace.json'
    save(ns_path, resource('Namespace', 'sign-' + name))
    kubectl('apply', '-f', str(ns_path))
    kubectl('apply', '-f', str(path), '--dry-run=server', '-o', 'name')
    kubectl('apply', '-f', str(path))


def activate(name):
    ns = 'sign-' + name
    cid = COMPANIES[name]
    work = ROOT / cid
    status = kubectl('-n', ns, 'exec', 'deployment/app', '--', 'su', '-s', '/bin/sh', 'www-data', '-c', 'php occ status --output=json', capture=True)
    body = json.loads(status.stdout)
    if not body.get('installed') or body.get('maintenance') or body.get('needsDbUpgrade'):
        raise RuntimeError('Nextcloud is not ready for public traffic')
    ip = kubectl('-n', ns, 'get', 'service', 'app', '-o', 'jsonpath={.spec.clusterIP}', capture=True).stdout
    if not re.fullmatch(r'10\.43\.\d+\.\d+', ip):
        raise RuntimeError('Unexpected service address')
    probe = run(['curl', '--fail', '--silent', '--max-time', '15', '-H', 'Host: erp.trusoft.ai', 'http://' + ip + '/status.php'], capture=True)
    health = json.loads(probe.stdout)
    if not health.get('installed') or health.get('maintenance') or health.get('needsDbUpgrade'):
        raise RuntimeError('Service readiness did not pass')
    for index, proxy in enumerate(('192.168.88.171', '10.42.0.1')):
        kubectl('-n', ns, 'exec', 'deployment/app', '--', 'su', '-s', '/bin/sh', 'www-data', '-c', f'php occ config:system:set trusted_proxies {index} --value={proxy}', capture=True)
    original = NGINX.read_text()
    old = f'proxy_pass http://127.0.0.1:{PORTS[name]}/;'
    new = f'proxy_pass http://{ip}:80/;'
    if original.count(old) != 1 and original.count(new) != 1:
        raise RuntimeError('Nginx upstream is unexpected; no configuration changed')
    backup = work / 'nginx-before.conf'
    if not backup.exists():
        save(backup, original)
    if old in original:
        NGINX.write_text(original.replace(old, new))
        try:
            run(['nginx', '-t'], capture=True)
            run(['systemctl', 'reload', 'nginx'])
        except Exception:
            NGINX.write_text(original)
            raise
    try:
        public = run(['curl', '--fail', '--silent', '--retry', '4', '--retry-delay', '1', '--retry-all-errors', '--max-time', '15', 'https://erp.trusoft.ai/signing/' + cid + '/status.php'], capture=True)
        final = json.loads(public.stdout)
        if not final.get('installed') or final.get('maintenance') or final.get('needsDbUpgrade'):
            raise RuntimeError('Public health failed; cron remains stopped')
    except Exception:
        if old in original:
            current = NGINX.read_text()
            if current.count(new) == 1:
                NGINX.write_text(current.replace(new, old))
                run(['nginx', '-t'], capture=True)
                run(['systemctl', 'reload', 'nginx'])
        raise
    save(work / 'activated.json', {'companyId': cid, 'namespace': ns, 'clusterIP': ip, 'status': final,
         'activatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'cronEnabled': False})
    print(name + ': public health verified; cron remains held pending acceptance')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'deploy', 'activate'])
    parser.add_argument('company', choices=list(COMPANIES) + ['all'])
    parser.add_argument('--image')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run as root; secret material is never printed')
    os.umask(0o077)
    for selected in COMPANIES if args.company == 'all' else [args.company]:
        if args.action == 'prepare':
            prepare(selected)
        elif args.action == 'deploy':
            if not args.image:
                parser.error('--image is required for deploy')
            deploy_company(selected, args.image)
        else:
            activate(selected)
