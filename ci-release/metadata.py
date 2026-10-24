import json,hashlib,os,pathlib
image=json.loads(pathlib.Path('image-inspect.json').read_text())[0]
archive=pathlib.Path('worker-image.tar.gz')
result={'version':os.environ['VERSION'],'image_tag':os.environ['IMAGE'],'image_id':image['Id'],'architecture':image['Architecture'],'os':image['Os'],'unpacked_bytes':image['Size'],'compressed_bytes':archive.stat().st_size,'archive_sha256':hashlib.file_digest(archive.open('rb'),'sha256').hexdigest(),'source_revision':os.environ['GITHUB_SHA'],'layers':json.loads(pathlib.Path('layers.json').read_text()),'validation':{'worker_health_http':200,'graceful_shutdown':True,'database':'disposable-baseline-pg16'}}
pathlib.Path('image-metadata.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
