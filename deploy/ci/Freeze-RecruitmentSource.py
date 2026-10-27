"""Create an immutable source-only handoff. This does not run builds or tests."""
import argparse
import hashlib
import json
import re
import os
from pathlib import Path
import subprocess
import tarfile
from datetime import datetime, timezone

EXCLUDED_DIRS={'.git','.runtime','.secrets','node_modules','dist','coverage','test-results','playwright-report','.cache','.pnpm-store','.cctmp','__pycache__','result'}
def sha(data):return hashlib.sha256(data).hexdigest()
def safe(relative):
 p=Path(relative)
 return (not p.is_absolute() and p.parts[0] != 'uploads' and p.name != '.DS_Store' and '..' not in p.parts and not any(x in EXCLUDED_DIRS or x.startswith('.env') or x in {'.npmrc','.pnpmrc'} for x in p.parts) and p.suffix.lower() not in {'.key','.pem','.pfx','.p12','.pyc','.xlsx','.xls','.csv','.dump','.bak','.log'} and not p.name.startswith(('lint-report','eslint-report')) and '\\' not in relative and ':' not in relative)
def git(exe,root,*args):return subprocess.check_output([exe,'-c','core.safecrlf=false','-C',str(root).removeprefix(chr(92)*2+'?'+chr(92)),*args],timeout=60)
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--output',required=True);parser.add_argument('--git',default='git');parser.add_argument('--base-archive');parser.add_argument('--repositories',nargs='+',choices=['erp-hr-backend','erp-contracts','erp-trusoft-frontend','erp-rbac-backend'],default=['erp-hr-backend','erp-contracts','erp-trusoft-frontend']);args=parser.parse_args()
 root=Path(args.root).resolve();out=Path(args.output).resolve()
 if os.name=='nt':
  root=Path(chr(92)*2+'?'+chr(92)+str(root));out=Path(chr(92)*2+'?'+chr(92)+str(out))
 if out.exists():raise ValueError('OUTPUT_MUST_BE_NEW')
 out.mkdir(parents=True);sources={};details={};inputs={}
 for name in args.repositories:
  repo=(root/name).resolve()
  if not repo.is_relative_to(root):raise ValueError('REPOSITORY_OUTSIDE_ROOT')
  paths=sorted(set(git(args.git,repo,'ls-files','--cached','--others','--exclude-standard','-z').decode().split('\0'))-{''})
  indexed={}
  for item in git(args.git,repo,'ls-files','--stage','-z').decode().split('\0'):
   if item:
    mode,oid,stage,path=item.split(maxsplit=3);indexed[path]=mode
  files={};manifest=[];excluded=[];deleted=[]
  for rel in paths:
   if not safe(rel):excluded.append(rel);continue
   source=repo/rel
   if source.is_symlink():raise ValueError('SOURCE_SYMLINK: '+name+'/'+rel)
   if not source.exists():deleted.append(rel);continue
   if not source.is_file():raise ValueError('SOURCE_NOT_REGULAR_FILE: '+rel)
   data=source.read_bytes()
   if re.search(rb'(?m)^-----BEGIN (?:(?:RSA|EC|OPENSSH) )?PRIVATE KEY-----[ \t]*$',data):raise ValueError('PRIVATE_KEY_CONTENT: '+name+'/'+rel)
   mode=0o755 if indexed.get(rel)=='100755' else 0o644
   target=out/'source'/name/rel;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data);target.chmod(mode)
   files[rel]=sha(data);manifest.append({'path':rel,'sha256':files[rel],'bytes':len(data),'mode':oct(mode)})
  for item in manifest:
   if sha((repo/item['path']).read_bytes())!=item['sha256']:raise ValueError('SOURCE_CHANGED_DURING_FREEZE')
  head=git(args.git,repo,'rev-parse','HEAD').decode().strip()
  changed=set(git(args.git,repo,'diff','--name-only','HEAD','-z').decode().split('\0'))
  selected=sorted(changed&set(paths)-set(excluded)-{''})
  patch=b''
  for i in range(0,len(selected),100):patch+=git(args.git,repo,'diff','--no-ext-diff','--binary','HEAD','--',*selected[i:i+100])
  patchpath=out/'provenance'/(name+'.patch');patchpath.parent.mkdir(exist_ok=True);patchpath.write_bytes(patch)
  sources[name]={'head':head,'workingTree':'Frozen current tracked and untracked source; not qualified','exportDigest':sha(json.dumps(files,sort_keys=True).encode()),'files':files}
  details[name]={'head':head,'files':manifest,'excludedPaths':excluded,'deletedTrackedPaths':deleted,'dirtyPatchSha256':sha(patch),'dirtyPatchBytes':len(patch)}
  inputs[name]={p:h for p,h in files.items() if Path(p).name in {'package.json','package-lock.json','pnpm-lock.yaml','yarn.lock','npm-shrinkwrap.json','schema.prisma'} or p.endswith(('.tgz','.tar.gz'))}
 (out/'sources.json').write_text(json.dumps(sources,sort_keys=True,indent=2)+'\n',encoding='utf-8')
 (out/'source-provenance.json').write_text(json.dumps(details,sort_keys=True,indent=2)+'\n',encoding='utf-8')
 (out/'dependency-inputs.json').write_text(json.dumps(inputs,sort_keys=True,indent=2)+'\n',encoding='utf-8')
 comparison={'state':'NO_REUSE_AUTHORIZED','reason':'Compare installed graph and generated Prisma inputs before selecting any runtime'}
 if args.base_archive:
  basepath=Path(args.base_archive);base_sources=None
  with tarfile.open(basepath,'r:gz') as archive:
   members=[m for m in archive.getmembers() if m.isfile() and m.name.rstrip('/').endswith('/sources.json')]
   if not members:members=[m for m in archive.getmembers() if m.isfile() and m.name=='sources.json']
   if len(members)!=1:raise ValueError('BASE_MANIFEST_AMBIGUOUS')
   base_sources=json.load(archive.extractfile(members[0]))
  comparison['baseArchiveSha256']=sha(basepath.read_bytes());comparison['repositories']={}
  for name,current in inputs.items():
   before=base_sources.get(name,{}).get('files',{});base_inputs={p:h for p,h in before.items() if Path(p).name in {'package.json','package-lock.json','pnpm-lock.yaml','yarn.lock','npm-shrinkwrap.json','schema.prisma'} or p.endswith(('.tgz','.tar.gz'))}
   differences=[{'path':p,'current':current.get(p),'base':base_inputs.get(p)} for p in sorted(set(current)|set(base_inputs)) if current.get(p)!=base_inputs.get(p)]
   comparison['repositories'][name]={'allBuildInputsMatch':not differences,'differences':differences}
 (out/'base-input-comparison.json').write_text(json.dumps(comparison,sort_keys=True,indent=2)+'\n',encoding='utf-8')
 archivepath=out.with_suffix('.tar.gz')
 if archivepath.exists():raise ValueError('ARCHIVE_ALREADY_EXISTS')
 # Enumerate declared names, not Windows directory entries: case aliases must survive.
 with tarfile.open(archivepath,'w:gz',compresslevel=1,dereference=True) as archive:
  for name,detail in sorted(details.items()):
   for item in detail['files']:
    arcname='source/'+name+'/'+item['path'];path=out/arcname
    if sha(path.read_bytes())!=item['sha256']:raise ValueError('FROZEN_SOURCE_CHANGED: '+arcname)
    info=archive.gettarinfo(path,arcname=arcname);info.mode=int(item['mode'],8)
    with path.open('rb') as data:archive.addfile(info,data)
  for path in sorted(out.rglob('*')):
   if path.is_file() and not path.is_relative_to(out/'source'):
    archive.add(path,arcname=path.relative_to(out).as_posix(),recursive=False)
 with tarfile.open(archivepath,'r:gz') as archive:
  members=archive.getmembers();names=[m.name for m in members]
  if len(names)!=len(set(names)) or any(not m.isfile() for m in members):raise ValueError('ARCHIVE_DUPLICATE_OR_NON_REGULAR')
  expected={'source/'+n+'/'+p:h for n,v in sources.items() for p,h in v['files'].items()}
  actual={m.name for m in members if m.name.startswith('source/')}
  if actual!=set(expected):raise ValueError('ARCHIVE_SOURCE_MEMBERSHIP_MISMATCH')
  for path,digest in expected.items():
   if sha(archive.extractfile(path).read())!=digest:raise ValueError('ARCHIVE_SOURCE_HASH_MISMATCH: '+path)
 receipt={'state':'FROZEN_NOT_QUALIFIED','createdAt':datetime.now(timezone.utc).isoformat(),'archive':str(archivepath),'sha256':sha(archivepath.read_bytes()),'bytes':archivepath.stat().st_size,'repositories':{n:{'head':v['head'],'files':len(v['files']),'exportDigest':v['exportDigest']} for n,v in sources.items()},'installedGraphReuse':'NOT_AUTHORIZED'}
 (out/'freeze-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8');print(json.dumps(receipt))
if __name__=='__main__':main()
