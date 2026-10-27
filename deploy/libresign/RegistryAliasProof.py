"""Admit the specific node registry alias only with a recent two-node receipt."""
import hashlib
import json
import time


def validate_receipt(receipt):
    if (receipt.get('state') != 'passed' or receipt.get('nodeAlias') != 'localhost:5000/erp-build/'
            or not time.time() < receipt.get('expiresAt', 0) <= time.time() + 86400
            or {n.get('name') for n in receipt.get('nodes', [])} != {'erptrusoft', 'trucodehub-runner'}
            or len(receipt.get('nodes', [])) != 2):
        raise ValueError('RECENT_TWO_NODE_REGISTRY_QUALIFICATION_REQUIRED')
    return receipt


def verify_live(kube, receipt):
    validate_receipt(receipt)
    ns = kube.get('namespace', 'erp-system', namespace=None)
    if ns['metadata']['uid'] != receipt['namespaceUid']:
        raise ValueError('REGISTRY_NAMESPACE_CHANGED')
    config = kube.get('configmap', 'erp-registry', namespace='erp-system')
    if hashlib.sha256(json.dumps(config['data'], sort_keys=True).encode()).hexdigest() != receipt['registryConfigSha256']:
        raise ValueError('REGISTRY_CONFIGURATION_CHANGED')
    for expected in receipt['nodes']:
        node = kube.get('node', expected['name'], namespace=None)
        if node['metadata']['uid'] != expected['uid'] or not any(
                c['type'] == 'Ready' and c['status'] == 'True' for c in node['status']['conditions']):
            raise ValueError('QUALIFIED_REGISTRY_NODE_CHANGED_OR_NOT_READY')
    readers = kube.get('pods', namespace='erp-system', selector='app=erp-registry-reader')['items']
    ready = {p['spec']['nodeName'] for p in readers if not p['metadata'].get('deletionTimestamp')
             and any(c['type'] == 'Ready' and c['status'] == 'True' for c in p['status'].get('conditions', []))}
    if ready != {'erptrusoft', 'trucodehub-runner'}:
        raise ValueError('QUALIFIED_REGISTRY_READERS_NOT_READY')
    return {'nodeAlias': receipt['nodeAlias'], 'qualifiedAt': receipt['qualifiedAt'],
            'registryConfigSha256': receipt['registryConfigSha256']}
