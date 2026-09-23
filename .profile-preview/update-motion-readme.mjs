import fs from 'node:fs';
let md=fs.readFileSync('README.md','utf8');
md=md.replace('## Recognition',`## At a glance

- **For hiring teams:** Trainee Software Engineer at 10QBIT, with internship and freelance experience, competition recognition and a Computer Science degree in progress.
- **For technical leaders:** Explore working examples of browser automation, multimodal AI integration and Android data architecture, with source code and project limitations documented.
- **For founders & business leaders:** My projects explore practical workflows in software quality, healthcare interaction and financial data access.

## Recognition`);
md=md.replace('## Technical toolkit','## Tech stack\n\n<img src="assets/tech-stack.svg" width="100%" alt="Animated 3D-style technology tiles: Python, TypeScript, JavaScript, React, HTML5, CSS3, Java, Kotlin, Android, Firebase, Node.js, FastAPI, Docker, Git, Google Cloud, MySQL, MongoDB and SQLite." />\n\nTechnologies used across my projects and learning. The linked repositories show where and how I apply them.');
md=md.replace('## Education',`## Contribution activity

<picture>
  <source media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/kowshi1119/kowshi1119/output/github-snake-dark-static.svg" />
  <source media="(prefers-reduced-motion: reduce)" srcset="https://raw.githubusercontent.com/kowshi1119/kowshi1119/output/github-snake-static.svg" />
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/kowshi1119/kowshi1119/output/github-snake-dark.svg" />
  <img src="https://raw.githubusercontent.com/kowshi1119/kowshi1119/output/github-snake.svg" width="100%" alt="Animated snake following my actual GitHub contributions on a raised perspective board; refreshed daily." />
</picture>

[View contribution history →](https://github.com/kowshi1119?tab=overview)

## Education`);
md=md.replace("If you're recruiting for a software engineering team, I'd be happy to discuss my projects, experience and career interests.","Recruiting for an engineering team, reviewing technical fit, or exploring a product idea? I'd be happy to walk you through my projects, implementation decisions and career interests.");
fs.writeFileSync('README.md',md);
