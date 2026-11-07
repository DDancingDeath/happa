const fs=require('fs'),path=require('path');
function walk(d,ext,out=[]){for(const f of fs.readdirSync(d)){const p=path.join(d,f);const s=fs.statSync(p);if(s.isDirectory())walk(p,ext,out);else if(ext.some(e=>p.endsWith(e)))out.push(p);}return out;}
const tpl=walk('www/templates',['.html']); const js=walk('www/js',['.js']); const css=walk('www/css',['.css']).filter(f=>!f.endsWith('app.css'));
const hex=/#[0-9a-fA-F]{3,8}\b/g, rgb=/rgba?\([^)]*\)/g;
let r={};
let tplStyle=0, tplStyleFiles={};for(const f of tpl){const t=fs.readFileSync(f,'utf8');const n=(t.match(/style="/g)||[]).length;tplStyle+=n;tplStyleFiles[path.basename(f)]=n;}
r.templateInlineStyles=tplStyle; r.tplByFile=tplStyleFiles;
let jsStyle=0,jsHex=0,jsFiles={};for(const f of js){const t=fs.readFileSync(f,'utf8');const n=(t.match(/style="|style='|style=\\"|\.style\.(cssText|background|color)/g)||[]).length;const h=(t.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?=[;'" ])/g)||[]).length;jsStyle+=n;jsHex+=h;if(n+h>15)jsFiles[path.relative('www/js',f)]=n+'/'+h;}
r.jsInlineStyleAttrs=jsStyle;r.jsHexColours=jsHex;r.jsHotFiles=jsFiles;
let cssHex=0,cssVar=0,cssImp=0,cssRules=0,cssByFile={};for(const f of css){const t=fs.readFileSync(f,'utf8');const h=(t.match(hex)||[]).length+(t.match(rgb)||[]).length;const v=(t.match(/var\(--/g)||[]).length;cssHex+=h;cssVar+=v;cssImp+=(t.match(/!important/g)||[]).length;cssRules+=(t.match(/\{/g)||[]).length;cssByFile[path.basename(f)]=h;}
r.cssRawColours=cssHex;r.cssVarUses=cssVar;r.cssImportant=cssImp;r.cssRuleBlocks=cssRules;r.cssRawByFile=cssByFile;
// emoji
const emo=/\p{Extended_Pictographic}/gu; let te=0,je=0; for(const f of tpl)te+=(fs.readFileSync(f,'utf8').match(emo)||[]).length; for(const f of js)je+=(fs.readFileSync(f,'utf8').match(emo)||[]).length; r.emojiTemplates=te;r.emojiJs=je;
// font-size distinct
let fs_={};for(const f of css){for(const m of fs.readFileSync(f,'utf8').matchAll(/font-size:\s*([^;]+);/g))fs_[m[1].trim()]=(fs_[m[1].trim()]||0)+1;} r.distinctFontSizes=Object.keys(fs_).length; r.topFontSizes=Object.entries(fs_).sort((a,b)=>b[1]-a[1]).slice(0,20);
let rad={};for(const f of css){for(const m of fs.readFileSync(f,'utf8').matchAll(/border-radius:\s*([^;]+);/g))rad[m[1].trim()]=(rad[m[1].trim()]||0)+1;} r.distinctRadii=Object.keys(rad).length;r.topRadii=Object.entries(rad).sort((a,b)=>b[1]-a[1]).slice(0,12);
let sh={};for(const f of css){for(const m of fs.readFileSync(f,'utf8').matchAll(/box-shadow:\s*([^;]+);/g))sh[m[1].trim()]=1;} r.distinctShadows=Object.keys(sh).length;
let fw={};for(const f of css){for(const m of fs.readFileSync(f,'utf8').matchAll(/font-weight:\s*([^;]+);/g))fw[m[1].trim()]=(fw[m[1].trim()]||0)+1;} r.fontWeights=fw;
let mq={};for(const f of css){for(const m of fs.readFileSync(f,'utf8').matchAll(/@media\s*([^{]+)\{/g))mq[m[1].trim()]=(mq[m[1].trim()]||0)+1;} r.mediaQueries=Object.entries(mq).sort((a,b)=>b[1]-a[1]).slice(0,15);
// gradients
let gr=0;for(const f of css)gr+=(fs.readFileSync(f,'utf8').match(/gradient\(/g)||[]).length; r.cssGradients=gr;
// dark-mode selectors
let dm=0;for(const f of css)dm+=(fs.readFileSync(f,'utf8').match(/\.dark-mode/g)||[]).length; r.darkModeSelectors=dm;
// card-like classes
let cards={};for(const f of css){for(const m of fs.readFileSync(f,'utf8').matchAll(/\.([a-z0-9-]*card[a-z0-9-]*)/g))cards[m[1]]=1;} r.cardClasses=Object.keys(cards).length;
let btns={};for(const f of css){for(const m of fs.readFileSync(f,'utf8').matchAll(/\.([a-z0-9-]*(btn|button)[a-z0-9-]*)/g))btns[m[1]]=1;} r.btnClasses=Object.keys(btns).length;
r.cssFiles=css.length; r.tplFiles=tpl.length; r.jsFiles=js.length;
console.log(JSON.stringify(r,null,1));
