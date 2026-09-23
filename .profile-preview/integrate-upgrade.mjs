import fs from 'node:fs';
let script=fs.readFileSync('scripts/build-graphics.mjs','utf8');
script=script.slice(0,script.indexOf('const prism='))+script.slice(script.indexOf('const rows='),script.indexOf('// Retain the project layouts;'));
script+="console.log('Generated animated technology board.');\n";
fs.writeFileSync('scripts/build-tech-stack.mjs',script);
fs.unlinkSync('scripts/build-graphics.mjs');
let md=fs.readFileSync('README.md','utf8');
md=md.replace('## Recognition',`## At a glance

- **For hiring teams:** Trainee Software Engineer at 10QBIT, with internship and freelance experience, competition recognition and a Computer Science degree in progress.
- **For technical leaders:** Explore browser automation, multimodal AI integration and Android data architecture, with source code and project limitations documented.
- **For founders & business leaders:** My projects explore practical workflows in software quality, healthcare interaction and financial data access.

## Recognition`);
md=md.replace('## Technical toolkit',`## Technical toolkit

<picture>
  <source media="(prefers-reduced-motion: reduce)" srcset="assets/tech-stack-static.svg" />
  <img src="assets/tech-stack.svg" width="100%" alt="Floating 3D-style technology tiles: Python, TypeScript, JavaScript, React, HTML5, CSS3, Java, Kotlin, Android, Firebase, Node.js, FastAPI, Docker, Git, Google Cloud, MySQL, MongoDB and SQLite." />
</picture>

Technologies used across my projects and learning. The linked repositories show where and how I apply them.`);
md=md.replace('<source media="(max-width: 600px)"',`<source media="(prefers-reduced-motion: reduce) and (max-width: 600px)" srcset="assets/profile-hero-mobile-static.svg" />
    <source media="(prefers-reduced-motion: reduce)" srcset="assets/profile-hero-static.svg" />
    <source media="(max-width: 600px)"`);
md=md.replace(/<img src="assets\/(project-[a-z]+)\.svg"[^>]*\/>/g,(img,name)=>`<picture><source media="(prefers-reduced-motion: reduce)" srcset="assets/${name}-static.svg" />${img}</picture>`);
md=md.replace('<source srcset="https://raw.githubusercontent.com/kowshi1119/kowshi1119/output/contribution-snake.svg"',`<source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/kowshi1119/kowshi1119/output/contribution-snake-static.svg" />
    <source srcset="https://raw.githubusercontent.com/kowshi1119/kowshi1119/output/contribution-snake.svg"`);
md=md.replace("If you're recruiting for a software engineering team, I'd be happy to discuss my projects, experience and career interests.","Recruiting for an engineering team, reviewing technical fit, or exploring a product idea? I'd be happy to walk you through my projects, implementation decisions and career interests.");
fs.writeFileSync('README.md',md);
let wf=fs.readFileSync('.github/workflows/snake.yml','utf8');
wf=wf.replace('      - "scripts/style_snake.py"','      - "scripts/style_snake.py"\n      - "scripts/build_static_assets.py"');
wf=wf.replace('        run: python3 scripts/style_snake.py dist/github-snake.svg dist/contribution-snake.svg','        run: |\n          python3 scripts/style_snake.py dist/github-snake.svg dist/contribution-snake.svg\n          python3 scripts/build_static_assets.py dist/contribution-snake.svg');
wf=wf.replace('git add github-snake.svg github-snake-dark.svg contribution-snake.svg','git add github-snake.svg github-snake-dark.svg contribution-snake.svg contribution-snake-static.svg');
fs.writeFileSync('.github/workflows/snake.yml',wf);
