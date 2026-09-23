from pathlib import Path
p=Path('assets/hero/source/optimize_gif.py')
s=p.read_text(encoding='utf-8')
s=s.replace("    gif=Image.open(source)","    GifImagePlugin.LOADING_STRATEGY = GifImagePlugin.LoadingStrategy.RGB_AFTER_DIFFERENT_PALETTE_ONLY\n    gif=Image.open(source)")
a=s.index('            rgba=gif.convert(')
b=s.index('            frame.info[',a)
s=s[:a]+'''            if gif.mode != 'P' or gif.getpalette() != palette:
                raise ValueError('Expected a fixed global palette; regenerate with the supplied renderer')
            frame=gif.copy()
'''+s[b:]
p.write_text(s,encoding='utf-8')
p=Path('assets/hero/source/render.mjs');s=p.read_text(encoding='utf-8')
s=s.replace("const palette=path.join(dir,'palette.png');","const palette=path.join(dir,'palette.png');\n const raw=path.join(dir,'unoptimized.gif');")
s=s.replace("'-loop','0',out]);","'-loop','0',raw]);\n const optimized=spawnSync(option('--python','python'),[path.join(source,'optimize_gif.py'),raw,out],{encoding:'utf8',maxBuffer:8*1024*1024});\n if(optimized.error||optimized.status!==0)throw Error(optimized.error?.message||optimized.stderr);\n console.log(optimized.stdout.trim());")
s=s.replace("for(let i=0;i<frames;i++){","for(let i=0;i<frames;i++){\n   if(args.includes('--reuse-frames')){try{await fs.access(path.join(dir,String(i).padStart(4,'0')+'.png'));continue}catch{}}")
p.write_text(s,encoding='utf-8')
