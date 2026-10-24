import tarfile,json,gzip,io,pathlib
with tarfile.open('image.tar') as tf:
 manifest=json.load(tf.extractfile('manifest.json'))[0]
 config=json.load(tf.extractfile(manifest['Config']))
 layers=[]
 for digest,name in zip(config['rootfs']['diff_ids'],manifest['Layers'],strict=True):
  member=tf.getmember(name); f=tf.extractfile(member); head=f.read(2)
  if head==b'\x1f\x8b':
   stream=gzip.GzipFile(fileobj=io.BytesIO(head+f.read())); size=0
   while chunk:=stream.read(1048576): size+=len(chunk)
  else: size=member.size
  layers.append({'diff_id':digest,'tar_bytes':size,'stored_bytes':member.size})
pathlib.Path('layers.json').write_text(json.dumps(layers))
print(json.dumps({'layers':len(layers),'uncompressed_tar_bytes':sum(l['tar_bytes'] for l in layers)}))
