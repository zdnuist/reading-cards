/**
 * 命令行同步：node --experimental-sqlite sync.js [limit]
 * limit=0 表示同步全部有笔记的书
 */
import { runSync, syncState, stats } from './weread.js';

const limit = Number(process.argv[2] ?? 0);
const includeShelf = process.argv[3] !== 'noshelf';

const t0 = Date.now();
const st = await runSync({ limit, includeShelf });
const s = stats();

console.log('');
console.log('  同步结果');
console.log('  ────────────────────────────');
console.log(`  阶段        ${st.phase}`);
console.log(`  处理书籍    ${st.done}/${st.total}`);
console.log(`  书架条目    ${st.books}`);
console.log(`  本轮划线    ${st.highlights}`);
console.log(`  本轮想法    ${st.thoughts}`);
console.log(`  耗时        ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('  ────────────────────────────');
console.log(`  库内书籍    ${s.books}`);
console.log(`  库内划线    ${s.highlights}`);
console.log(`  库内想法    ${s.thoughts}`);
if (st.error) console.log(`  错误        ${st.error}`);
console.log('');
