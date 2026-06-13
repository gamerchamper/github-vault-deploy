/**
 * Add -webkit-user-select before user-select in plyr.css (Safari).
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../public/css/plyr.css');
let css = fs.readFileSync(file, 'utf8');
css = css.replace(/(?<!-webkit-)user-select:none/g, '-webkit-user-select:none;user-select:none');
fs.writeFileSync(file, css);
console.log('Patched plyr.css user-select prefixes');
