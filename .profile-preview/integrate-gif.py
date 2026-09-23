from pathlib import Path
p=Path('README.md')
s=p.read_text(encoding='utf-8')
end=s.index('</p>')+4
hero='''<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce) and (max-width: 600px)" srcset="assets/hero/ai-qa-dev-flow-mobile.png" />
    <source media="(prefers-reduced-motion: reduce)" srcset="assets/hero/ai-qa-dev-flow.png" />
    <source media="(max-width: 600px)" srcset="assets/hero/ai-qa-dev-flow-mobile.gif" />
    <img src="assets/hero/ai-qa-dev-flow.gif" width="100%" alt="Kowshikan Mathivarnan — conceptual animation of an AI-powered QA and software development workflow showing code, automated testing, bug detection, CI/CD and web/mobile validation." />
  </picture>
</p>

### Building intelligent software systems where AI, automation, testing, and product engineering meet.

`AI Engineering` · `QA Automation` · `Playwright` · `Software Testing` · `React` · `Android` · `Node.js` · `TypeScript`

[View still image](assets/hero/ai-qa-dev-flow.png)'''
s=hero+s[end:]
s=s.replace('\n# Building software for real-world workflows.\n','')
p.write_text(s,encoding='utf-8')
