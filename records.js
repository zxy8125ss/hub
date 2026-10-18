/* 我的记录：导入各 App 的备份文件，合并去重后存在总控台本机，可查看、按 App 导出、全部导出。
   记录只存在这台设备的总控台里，不上传。导出的「备份文件」是各 App 自己的格式，可以导回原 App。 */
(function () {
  const OWNER = 'zxy8125ss';
  const pad = n => String(n).padStart(2, '0');
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const toMs = v => v == null ? 0 : typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : (Date.parse(v) || 0);
  const ymd = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const hhmm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const dur = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} 小时${m ? ` ${m} 分钟` : ''}` : `${Math.max(1, m)} 分钟`; };

  /* 题目、事件名等标题从各 App 的公开内容里取 */
  const titleCache = {};
  async function titles(kind) {
    if (titleCache[kind]) return titleCache[kind];
    const map = {};
    try {
      if (kind === 'crosscheck') {
        const d = await (await fetch(`https://${OWNER}.github.io/crosscheck/data/index.json`)).json();
        for (const it of d.items || []) map[it.id] = `第 ${it.chapter} 章 · ${it.title}`;
      } else if (kind === 'lp') {
        const d = await (await fetch(`https://raw.githubusercontent.com/${OWNER}/leader-party-newchina/main/data/content/events.json`)).json();
        for (const e of d) map[e.id] = `${e.date ? e.date.slice(0, 4) + ' · ' : ''}${e.title}`;
      }
    } catch (e) {}
    return (titleCache[kind] = map);
  }

  /* 每个 App：识别、拆成集合（按主键合并）、展示条目、重建成 App 自己的备份格式 */
  const APPS = {
    forge: {
      name: 'Forge', match: d => d.app === 'forge',
      how: '在 Forge「记录」页右上角点「导出与备份」→「完整备份」',
      split: d => ({ projects: keyed(d.projects, x => x.id), records: keyed(d.records, x => x.id) }),
      stamp: (c, x) => toMs(x.updatedAt || x.endAt || x.startAt || x.createdAt),
      async items(C) {
        const pn = id => (C.projects[id] || {}).name || '已删除的项目';
        return Object.values(C.records).map(r => ({ at: toMs(r.startAt), title: `${pn(r.projectId)} · 专注 ${dur(r.duration || 0)}${r.mood ? ' · ' + r.mood : ''}`, text: r.note || '' }));
      },
      build: (C, meta) => ({ app: 'forge', version: meta.version || 1, exportedAt: new Date().toISOString(), projects: Object.values(C.projects), records: Object.values(C.records) })
    },
    ease: {
      name: 'Ease', match: d => d.app === 'ease',
      how: '在 Ease 的「数据」卡片点「备份到「文件」」',
      split: d => ({ profile: keyed(d.profile, x => x.id), meals: keyed(d.meals, x => String(x.createdAt || x.id)), days: keyed(d.days, x => x.date), weights: keyed(d.weights, x => x.date) }),
      stamp: (c, x) => c === 'meals' ? toMs(x.createdAt) : 0,
      async items(C) {
        const out = [];
        for (const m of Object.values(C.meals)) out.push({ at: toMs(m.createdAt) || toMs(m.date), title: `${m.mealType || '一餐'} · ${Math.round(m.totalKcal || 0)} 千卡`, text: (m.items || []).map(i => `${i.name} ${i.kcal} 千卡`).join('、') });
        for (const w of Object.values(C.weights)) out.push({ at: toMs(w.date + 'T07:00:00'), title: `体重 ${w.jin} 斤`, text: '' });
        for (const d of Object.values(C.days)) {
          const bits = [d.steps != null && `走了 ${d.steps} 步`, d.sleepHours != null && `睡了 ${d.sleepHours} 小时`, d.exerciseDone && d.exerciseDone.length && `运动：${d.exerciseDone.join('、')}`, d.overate && d.overate !== 'none' && (d.overate === 'lot' ? '前一天吃多了很多' : '前一天吃多了一些')].filter(Boolean);
          if (bits.length) out.push({ at: toMs(d.date + 'T21:00:00'), title: '当天打卡', text: bits.join('；') });
        }
        return out;
      },
      build: C => ({ app: 'ease', version: 1, exportedAt: new Date().toISOString(), profile: Object.values(C.profile), meals: Object.values(C.meals), days: Object.values(C.days), weights: Object.values(C.weights) })
    },
    crosscheck: {
      name: 'Crosscheck', match: d => d.app === 'crosscheck',
      how: '在 Crosscheck「我的」页点「发到微信」，把文件存到「文件」',
      split: d => ({ entries: keyed(d.entries, x => x.itemId), duels: keyed(d.duels, x => `${x.itemId}|${x.friendName}|${x.at}|${x.friendText}`), meta: keyed(d.meta, x => x.key) }),
      stamp: (c, x) => toMs(x.updatedAt || x.at),
      merge: (c, cur, inc) => {   // 想法按时间合并去重，其余取较新的
        if (c !== 'entries') return null;
        const base = (inc.updatedAt || '') > (cur.updatedAt || '') ? inc : cur, seen = new Set();
        const thoughts = [...(cur.thoughts || []), ...(inc.thoughts || [])].filter(t => { const k = t.at + '\0' + t.text; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.at.localeCompare(b.at));
        return { ...base, thoughts };
      },
      async items(C) {
        const T = await titles('crosscheck');
        const CMP = { same: '所见略同', new: '未曾设想', doubt: '存疑' }, ACT = { done: '做到了', plan: '打算', na: '不适用' };
        const out = Object.values(C.entries).map(e => ({
          at: toMs(e.updatedAt), title: T[e.itemId] || e.itemId,
          text: [...(e.thoughts || []).map(t => `【${t.at}】${t.text}`), e.compare && `对照：${CMP[e.compare] || e.compare}`, e.action && `行动：${ACT[e.action] || e.action}`, e.note && `笔记：${e.note}`].filter(Boolean).join('\n')
        }));
        for (const d of Object.values(C.duels)) out.push({ at: toMs(d.at), title: `和 ${d.friendName} 对照 · ${T[d.itemId] || d.itemId}`, text: `我：${d.myText}\n${d.friendName}：${d.friendText}` });
        return out;
      },
      build: (C, meta) => ({ app: 'crosscheck', schema: meta.schema || 1, exportedAt: new Date().toISOString(), content: meta.content, entries: Object.values(C.entries), duels: Object.values(C.duels), meta: Object.values(C.meta) })
    },
    zuoyou: {
      name: '左右千年', match: d => d.app === 'zuoyou-notes' || (Array.isArray(d) && d.some(n => n && typeof n.id === 'string' && typeof n.text === 'string' && 'ts' in n)),
      how: '在左右千年「笔记」页点「导出完整备份（.json）」',
      split: d => { const list = Array.isArray(d) ? d : d.notes; return { notes: keyed(list, x => x.id), answers: keyed(Object.entries((d && d.answers) || {}).map(([k, v]) => ({ k, v })), x => x.k) }; },
      stamp: (c, x) => c === 'notes' ? toMs(x.upd || x.ts) : 0,
      async items(C) {
        const KIND = { lesson: '课程', ev: '事件', person: '人物' };
        const out = Object.values(C.notes).filter(n => !n.del && !n.purged).map(n => ({ at: toMs(n.ts), title: n.link ? `${KIND[n.link.k] || ''}：${n.link.title}` : '笔记', text: n.text || '' }));
        for (const a of Object.values(C.answers)) { let v = a.v; try { v = JSON.parse(v); } catch (e) {} if (typeof v === 'object') v = JSON.stringify(v); if (v) out.push({ at: 0, title: `思考题作答 · ${a.k.replace('zy.note.', '')}`, text: String(v) }); }
        return out;
      },
      build: C => { const notes = Object.values(C.notes); return { app: 'zuoyou-notes', version: 2, exported: new Date().toISOString(), count: notes.filter(n => !n.del).length, notes, answers: Object.fromEntries(Object.values(C.answers).map(a => [a.k, a.v])) }; }
    },
    lp: {
      name: '领袖·政党·新中国', match: d => d.app === 'leader-party-newchina',
      how: '在领袖·政党·新中国的「设置」页导出备份文件',
      split: d => ({
        notes: keyed(Object.values(d.notes || {}), x => x.eventId), texts: keyed(Object.values(d.texts || {}), x => x.eventId),
        favorites: keyed(d.favorites, x => x.eventId), wrongQuestions: keyed(d.wrongQuestions, x => x.questionId),
        readEvents: keyed(Object.values(d.readEvents || {}), x => x.eventId), errorReports: keyed(d.errorReports, x => `${x.eventId}|${x.createdAt}|${x.description}`),
        progress: keyed(d.readingProgress && Object.keys(d.readingProgress).length ? [{ key: 'last', ...d.readingProgress }] : [], x => 'last')
      }),
      stamp: (c, x) => toMs(x.updatedAt || x.lastOpenedAt || x.lastAnsweredAt || x.lastReadTimestamp || x.createdAt),
      async items(C) {
        const T = await titles('lp');
        const out = Object.values(C.notes).filter(n => n.text).map(n => ({ at: toMs(n.updatedAt || n.createdAt), title: `笔记 · ${T[n.eventId] || n.eventId}`, text: n.text }));
        for (const t of Object.values(C.texts)) if (t.text) out.push({ at: toMs(t.updatedAt), title: `录入的原文 · ${T[t.eventId] || t.eventId}`, text: t.text });
        for (const f of Object.values(C.favorites)) out.push({ at: toMs(f.createdAt), title: `收藏 · ${T[f.eventId] || f.eventId}`, text: '' });
        for (const r of Object.values(C.errorReports)) out.push({ at: toMs(r.createdAt), title: `纠错 · ${T[r.eventId] || r.eventId}`, text: r.description || '' });
        return out;
      },
      build: (C, meta) => {
        const obj = coll => Object.fromEntries(Object.values(coll).map(x => [x.eventId, x]));
        const prog = Object.values(C.progress)[0] || {};
        const { key, ...readingProgress } = prog;
        return { app: 'leader-party-newchina', version: meta.version || '1.1', exportedAt: new Date().toISOString(), contentVersion: meta.contentVersion || 1,
          notes: obj(C.notes), favorites: Object.values(C.favorites), wrongQuestions: Object.values(C.wrongQuestions), readEvents: obj(C.readEvents),
          readingProgress, errorReports: Object.values(C.errorReports), texts: obj(C.texts) };
      }
    }
  };
  const ORDER = ['forge', 'ease', 'crosscheck', 'zuoyou', 'lp'];
  const REPO = { forge: 'forge', ease: 'ease', crosscheck: 'crosscheck', zuoyou: 'zuoyou', lp: 'leader-party-newchina' };
  function keyed(list, fn) { const o = {}; for (const x of list || []) { if (x == null) continue; const k = fn(x); if (k != null && k !== '') o[k] = x; } return o; }

  /* ---------- 本机存储（IndexedDB） ---------- */
  const DB = 'hub-records';
  const open = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore('apps', { keyPath: 'id' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function getAll() { const db = await open(); return new Promise((res, rej) => { const q = db.transaction('apps').objectStore('apps').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); }); }
  async function put(rec) { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('apps', 'readwrite'); t.objectStore('apps').put(rec); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
  async function del(id) { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('apps', 'readwrite'); t.objectStore('apps').delete(id); t.oncomplete = res; t.onerror = () => rej(t.error); }); }

  /* ---------- 导入与合并 ---------- */
  async function importFile(file) {
    let d;
    try { d = JSON.parse(await file.text()); } catch (e) { return [{ file: file.name, error: '不是备份文件（需要 .json）' }]; }
    if (d && d.apps && typeof d.apps === 'object' && !Array.isArray(d.apps)) {   // 总控台导出的「全部合并备份」
      const out = [];
      for (const part of Object.values(d.apps)) out.push(await importData(part, file.name));
      return out;
    }
    return [await importData(d, file.name)];
  }
  async function importData(d, fileName) {
    const file = { name: fileName };
    const id = ORDER.find(k => APPS[k].match(d));
    if (!id) return { file: file.name, error: '认不出是哪个 App 的备份' };
    const A = APPS[id], incoming = A.split(d);
    const cur = (await getAll()).find(x => x.id === id) || { id, C: {}, meta: {}, imports: [] };
    let added = 0, updated = 0;
    for (const [c, items] of Object.entries(incoming)) {
      cur.C[c] = cur.C[c] || {};
      for (const [k, x] of Object.entries(items)) {
        const old = cur.C[c][k];
        if (!old) { cur.C[c][k] = x; added++; continue; }
        const merged = A.merge && A.merge(c, old, x);
        const next = merged || (A.stamp(c, x) >= A.stamp(c, old) ? x : old);
        if (JSON.stringify(next) !== JSON.stringify(old)) { cur.C[c][k] = next; updated++; }
      }
    }
    for (const f of ['version', 'schema', 'content', 'contentVersion']) if (d[f] != null) cur.meta[f] = d[f];
    cur.imports = [{ at: Date.now(), file: file.name, exportedAt: d.exportedAt || d.exported || null, added, updated }, ...(cur.imports || [])].slice(0, 50);
    await put(cur);
    return { file: file.name, app: A.name, added, updated };
  }

  /* ---------- 导出 ---------- */
  async function itemsOf(rec) { return (await APPS[rec.id].items(rec.C)).sort((a, b) => b.at - a.at); }
  function md(name, items) {
    const lines = [`# ${name} 记录`, '', `导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}　共 ${items.length} 条`, ''];
    let day = '';
    for (const it of items) {
      const key = it.at ? `${ymd(it.at)} ${WEEK[new Date(it.at).getDay()]}` : '未标日期';
      if (key !== day) { lines.push(`## ${key}`, ''); day = key; }
      lines.push(`### ${it.at ? hhmm(it.at) + ' · ' : ''}${it.title}`, '');
      if (it.text) lines.push(it.text.trim(), '');
    }
    return lines.join('\n');
  }
  async function save(name, text, type) {
    const blob = new Blob([text], { type }), file = new File([blob], name, { type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return true; } catch (e) { if (e && e.name === 'AbortError') return false; }
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); return true;
  }
  const stampName = () => { const d = new Date(); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; };
  async function exportOne(id, kind) {
    const rec = (await getAll()).find(x => x.id === id); if (!rec) return;
    const A = APPS[id];
    if (kind === 'md') return save(`${A.name}-记录-${stampName()}.md`, md(A.name, await itemsOf(rec)), 'text/markdown');
    return save(`${A.name}-合并备份-${stampName()}.json`, JSON.stringify(A.build(rec.C, rec.meta || {}), null, 1), 'application/json');
  }
  async function exportAll(kind) {
    const recs = (await getAll()).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    if (!recs.length) return;
    if (kind === 'md') {
      const parts = [`# 我的全部 App 记录`, '', `导出时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`, ''];
      for (const r of recs) { const it = await itemsOf(r); parts.push(md(APPS[r.id].name, it).replace(/^(#+) /gm, '#$1 '), ''); }
      return save(`全部App记录-${stampName()}.md`, parts.join('\n'), 'text/markdown');
    }
    const all = { exportedAt: new Date().toISOString(), note: '每个 App 一段，内容是该 App 自己的备份格式，可单独取出导回原 App', apps: {} };
    for (const r of recs) all.apps[REPO[r.id]] = APPS[r.id].build(r.C, r.meta || {});
    return save(`全部App合并备份-${stampName()}.json`, JSON.stringify(all, null, 1), 'application/json');
  }

  window.HubRecords = { APPS, ORDER, REPO, getAll, del, importFile, itemsOf, exportOne, exportAll, ymd, hhmm };
})();
