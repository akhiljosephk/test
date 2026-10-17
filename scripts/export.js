'use strict';
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const css=fs.readFileSync(path.join(root,'styles.css'),'utf8').replace(/^@import[^;]+;\n/,'');
const js=fs.readFileSync(path.join(root,'app.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace('<link rel="stylesheet" href="styles.css">',()=>'<style>'+css+'</style>').replace('<script src="app.js"></script>',()=>'<script>'+js+'</script>');
fs.writeFileSync(path.join(root,'mockups','MapleDesk-Interactive.html'),html);
console.log('Exported mockups/MapleDesk-Interactive.html (no external dependencies)');
