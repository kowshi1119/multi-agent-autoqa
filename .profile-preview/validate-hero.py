from pathlib import Path
from PIL import Image,ImageChops,ImageStat
import json,re
root=Path('kowshi1119');out=Path('.profile-preview')
reports=[]
for name in ['ai-qa-dev-flow','ai-qa-dev-flow-mobile']:
    path=root/'assets/hero'/f'{name}.gif'
    gif=Image.open(path)
    duration=0;last=None;first=None;deltas=[];name_first=None
    is_mobile='mobile' in name
    box=(30,65,660,225) if is_mobile else (50,110,595,290)
    for i in range(gif.n_frames):
        gif.seek(i);duration+=gif.info.get('duration',0)
        rgb=gif.convert('RGB');crop=rgb.crop(box)
        if name_first is None:name_first=crop
        elif ImageChops.difference(name_first,crop).getbbox():raise ValueError(f'{name}: name moves at frame {i}')
        small=rgb.resize((160,60))
        if first is None:first=small
        if last is not None:deltas.append(sum(ImageStat.Stat(ImageChops.difference(last,small)).mean)/3)
        last=small
    seam=sum(ImageStat.Stat(ImageChops.difference(last,first)).mean)/3
    if gif.n_frames!=250 or duration!=10000 or gif.info.get('loop')!=0:raise ValueError('Invalid loop metadata')
    if seam>max(deltas)+.1:raise ValueError('Loop seam larger than ordinary frame transitions')
    if path.stat().st_size>=10*1024*1024:raise ValueError('GIF too large')
    still=Image.open(path.with_suffix('.png'));still.verify()
    reports.append({'file':path.name,'size':gif.size,'bytes':path.stat().st_size,'frames':gif.n_frames,'durationMs':duration,'loop':0,'stableName':True,'seamMeanDelta':round(seam,5),'maximumOrdinaryDelta':round(max(deltas),5)})
md=(root/'README.md').read_text(encoding='utf-8')
assert not re.search(r'<(?:script|iframe|canvas)\b',md,re.I)
refs=re.findall(r'(?:src|srcset)="(assets/[^"]+)"',md)+re.findall(r'\]\((assets/[^)]+)\)',md)
for ref in refs:
    assert (root/ref).is_file(),f'Missing reference: {ref}'
report={'animations':reports,'relativeAssetReferences':len(refs),'unsupportedReadmeScripts':False}
(out/'hero-validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report,indent=2))
