/* =========================================================
   CSV 問卷表格：下載空白表格 ＋ 匯入預覽驗證
   ---------------------------------------------------------
   • PM.csvTemplate(spec)  下載空白問卷表格（含填寫說明列）
   • PM.csvImport(spec)    開啟匯入視窗：選檔 → 逐列驗證預覽 → 勾選後匯入
   • 支援 Excel 存檔常見狀況：UTF-8／Big5（繁中 Excel）／GBK（簡中 Excel）
     編碼自動判斷、日期被轉成 2026/11/1、進度填 40%、空白列、說明列
   spec = {
     name, title, columns:[{ key, label, required, hint, aliases }],
     prepare(rows, ctx) → items[{ line, title, sub, errors[], warnings[], include, data, dictAdds[] }],
     commit(items, ctx, progress) (async), okMsg, onDone()
   }
   ========================================================= */
(function () {
    'use strict';
    const PM = window.PM;
    const esc = PM.esc;

    /* ---------------- 解析 ---------------- */
    PM.csvParse = text => {
        text = String(text || '').replace(/^﻿/, '');
        const firstLine = text.split(/\r?\n/, 1)[0] || '';
        const delim = [',', '\t', ';'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
        const rows = [];
        let row = [], cell = '', q = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (q) {
                if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
                else cell += c;
            } else if (c === '"' && cell === '') q = true;
            else if (c === delim) { row.push(cell); cell = ''; }
            else if (c === '\n' || c === '\r') {
                if (c === '\r' && text[i + 1] === '\n') i++;
                row.push(cell); rows.push(row); row = []; cell = '';
            } else cell += c;
        }
        if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
        return rows;
    };

    const normHeader = s => String(s || '').replace(/^﻿/, '').replace(/[（(][^）)]*[）)]/g, '').replace(/[*＊\s　:：%％]/g, '').toLowerCase();

    // 依欄位名稱判斷最可能的編碼
    function decodeBest(buf, columns) {
        const names = columns.flatMap(c => [c.label, ...(c.aliases || [])]).map(normHeader);
        let best = null;
        for (const enc of ['utf-8', 'big5', 'gb18030']) {
            let text;
            try { text = new TextDecoder(enc, { fatal: enc === 'utf-8' }).decode(buf); } catch (e) { continue; }
            const header = (PM.csvParse(text.split(/\r?\n/, 1)[0])[0] || []).map(normHeader);
            const score = header.filter(h => names.includes(h)).length;
            if (!best || score > best.score) best = { enc, text, score };
            if (enc === 'utf-8' && score >= Math.min(3, columns.length)) break;
        }
        return best;
    }

    /* ---------------- 值的標準化工具（給各頁 prepare 使用） ---------------- */
    PM.csvVal = {
        // 2026-11-01、2026/11/1、2026.11.01 → 2026-11-01；空白回傳 ''；格式錯誤回傳 null
        date: v => {
            v = String(v || '').trim();
            if (!v) return '';
            const m = v.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
            if (!m) return null;
            const d = new Date(+m[1], +m[2] - 1, +m[3]);
            if (d.getMonth() !== +m[2] - 1) return null;
            return PM.fmtDate(d);
        },
        // 40、40%、0.4（Excel 百分比格式）→ 40；空白 → 0；錯誤 → null
        percent: v => {
            v = String(v || '').trim().replace(/[%％]/g, '');
            if (!v) return 0;
            let n = Number(v);
            if (!isFinite(n)) return null;
            if (n > 0 && n < 1 && /\./.test(v)) n = n * 100;
            n = Math.round(n);
            return n < 0 || n > 100 ? null : n;
        },
        pick: (v, list, aliases = {}) => {
            v = String(v || '').trim();
            if (!v) return '';
            if (list.includes(v)) return v;
            if (aliases[v]) return aliases[v];
            const hit = list.find(x => x.replace(/\s/g, '').toLowerCase() === v.replace(/\s/g, '').toLowerCase());
            return hit || null;
        }
    };

    /* ---------------- 空白問卷表格 ---------------- */
    PM.csvTemplate = spec => {
        const header = spec.columns.map(c => c.label + (c.required ? '*' : ''));
        const hint = spec.columns.map((c, i) => (i === 0 ? '【填寫說明，匯入時自動略過】' : '') + (c.required ? '必填。' : '選填。') + (c.hint || ''));
        PM.downloadCSV(header, [hint], `${spec.name}_問卷表格.csv`);
        PM.toast('已下載空白問卷表格，填好後按「匯入 CSV」');
    };

    /* ---------------- 匯入視窗 ---------------- */
    let modal = null;
    function ensureModal() {
        if (modal) return modal;
        modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'csvImportModal';
        modal.innerHTML = `<div class="modal-box csv-box">
            <div class="modal-title" id="csvTitle"></div>
            <div id="csvBody"></div>
        </div>`;
        document.body.appendChild(modal);
        return modal;
    }

    PM.csvImport = spec => {
        if (!PM.canEdit) { alert('您的帳號為唯讀權限，無法匯入資料。'); return; }
        const m = ensureModal();
        const st = { spec, rows: null, items: [], fileName: '', enc: '', autoDict: true, busy: false };
        m._st = st;
        m.querySelector('#csvTitle').textContent = `📥 匯入 CSV：${spec.title}`;
        renderPick(m, st);
        PM.openModal('csvImportModal');
    };

    function renderPick(m, st, error) {
        const spec = st.spec;
        m.querySelector('#csvBody').innerHTML = `
            <div class="csv-steps">
                <div><b>1.</b> 先按「📄 下載空白問卷表格」，用 Excel 填寫（一列一筆；第 2 列的填寫說明可保留，匯入時會自動略過）</div>
                <div><b>2.</b> 存檔為 CSV 後，拖曳到下方或點擊選擇檔案</div>
                <div><b>3.</b> 確認每一列的檢查結果，勾選要匯入的資料後按「確認匯入」</div>
            </div>
            ${error ? `<div class="csv-error">${error}</div>` : ''}
            <label class="csv-drop" id="csvDrop">
                <input type="file" accept=".csv,text/csv,.txt" id="csvFile" hidden>
                <div class="csv-drop-icon">📄</div>
                <div><b>點此選擇 CSV 檔案</b>，或將檔案拖曳到這裡</div>
                <div class="muted">支援 Excel 存成的「CSV UTF-8」或一般「CSV（逗號分隔）」</div>
            </label>
            <div class="csv-cols"><b>表格欄位：</b>${spec.columns.map(c => `<span class="csv-col ${c.required ? 'req' : ''}" title="${esc(c.hint || '')}">${esc(c.label)}${c.required ? '*' : ''}</span>`).join('')}</div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-act="tpl">📄 下載空白問卷表格</button>
                <span style="flex:1"></span>
                <button type="button" class="btn btn-secondary" data-act="close">取消</button>
            </div>`;
        const input = m.querySelector('#csvFile'), drop = m.querySelector('#csvDrop');
        input.onchange = () => input.files[0] && readFile(m, st, input.files[0]);
        drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
        drop.ondragleave = () => drop.classList.remove('over');
        drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) readFile(m, st, f); };
        m.querySelector('[data-act=tpl]').onclick = () => PM.csvTemplate(spec);
        m.querySelector('[data-act=close]').onclick = () => PM.closeModal('csvImportModal');
    }

    // 以程式指定檔案（拖放、自動化測試用）
    PM.csvImportFile = file => modal && modal._st && readFile(modal, modal._st, file);

    PM._csvReadFile = (file) => new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error('檔案讀取失敗'));
        r.readAsArrayBuffer(file);
    });

    async function readFile(m, st, file) {
        const spec = st.spec;
        if (file.size > 5 * 1024 * 1024) { renderPick(m, st, '檔案超過 5MB，請分批匯入。'); return; }
        let buf;
        try { buf = await PM._csvReadFile(file); } catch (e) { renderPick(m, st, e.message); return; }
        const best = decodeBest(buf, spec.columns);
        if (!best) { renderPick(m, st, '無法辨識檔案編碼，請在 Excel 另存為「CSV UTF-8（逗號分隔）」後再試。'); return; }
        const table = PM.csvParse(best.text);
        if (!table.length) { renderPick(m, st, '檔案是空的。'); return; }
        const header = table[0].map(normHeader);
        const colIdx = {};
        spec.columns.forEach(c => {
            const names = [c.label, ...(c.aliases || [])].map(normHeader);
            const i = header.findIndex(h => names.includes(h));
            if (i >= 0) colIdx[c.key] = i;
        });
        const missing = spec.columns.filter(c => c.required && colIdx[c.key] === undefined).map(c => c.label);
        if (missing.length) {
            renderPick(m, st, `找不到必要欄位：<b>${missing.map(esc).join('、')}</b>。<br>請使用本頁「📄 下載空白問卷表格」的欄位名稱（第一列必須是欄位標題）。`);
            return;
        }
        const rows = [];
        table.slice(1).forEach((cells, i) => {
            if (cells.every(c => !String(c).trim())) return;               // 空白列
            if (/^\s*【/.test(cells[0] || '')) return;                     // 填寫說明列
            const o = { __line: i + 2 };
            spec.columns.forEach(c => { o[c.key] = colIdx[c.key] === undefined ? '' : String(cells[colIdx[c.key]] ?? '').trim(); });
            rows.push(o);
        });
        st.rows = rows; st.fileName = file.name; st.enc = best.enc;
        if (!rows.length) { renderPick(m, st, '檔案中沒有可匯入的資料列（只有標題或說明列）。'); return; }
        buildItems(st);
        renderPreview(m, st);
    }

    function buildItems(st) {
        const dicts = PM.getDicts();
        const ctx = {
            dicts, autoDict: st.autoDict,
            // 檢查字典值；不存在時依「自動加入字典」選項決定是警告或錯誤
            dict(key, value, label, item) {
                if (!value) return '';
                const hit = PM.csvVal.pick(value, dicts[key]);
                if (hit) return hit;
                if (ctx.autoDict) { item.warnings.push(`${label}「${value}」不在參數字典中，將自動新增`); item.dictAdds.push([key, value]); return value; }
                item.errors.push(`${label}「${value}」不在參數字典中（可勾選下方「自動新增到參數字典」）`);
                return null;
            }
        };
        // 重新驗證時保留使用者先前的勾選（先前因錯誤無法勾選的列，改用預設值）
        const prev = new Map(st.items.map(it => [it.key, { include: it.include, hadErr: it.errors.length > 0 }]));
        st.items = st.spec.prepare(st.rows, ctx).map((it, i) => {
            it.key = it.key || String(it.line || i);
            it.errors = it.errors || []; it.warnings = it.warnings || []; it.dictAdds = it.dictAdds || [];
            const p = prev.get(it.key);
            if (it.errors.length) it.include = false;
            else if (p && !p.hadErr) it.include = p.include;
            else it.include = it.include !== false;
            return it;
        });
    }

    function renderPreview(m, st) {
        const items = st.items;
        const nErr = items.filter(i => i.errors.length).length;
        const nWarn = items.filter(i => !i.errors.length && i.warnings.length).length;
        const nSel = items.filter(i => i.include).length;
        const hasDictIssue = items.some(i => i.dictAdds.length || i.errors.some(e => /參數字典/.test(e)));
        m.querySelector('#csvBody').innerHTML = `
            <div class="csv-summary">
                <span>📄 ${esc(st.fileName)}<span class="muted">（${st.enc === 'utf-8' ? 'UTF-8' : st.enc === 'big5' ? 'Big5 繁中' : 'GBK 簡中'} 編碼，${st.rows.length} 列資料）</span></span>
                <span class="csv-pill ok">可匯入 ${items.length - nErr}</span>
                ${nWarn ? `<span class="csv-pill warn">有提醒 ${nWarn}</span>` : ''}
                ${nErr ? `<span class="csv-pill err">錯誤 ${nErr}</span>` : ''}
            </div>
            ${hasDictIssue ? `<label class="csv-opt"><input type="checkbox" id="csvAutoDict" ${st.autoDict ? 'checked' : ''}> 表格中出現參數字典沒有的「類型／廠區」時，自動新增到參數字典</label>` : ''}
            <div class="csv-table-wrap"><table class="csv-table">
                <thead><tr><th style="width:34px"><input type="checkbox" id="csvAll" title="全選／全不選" ${nSel && nSel === items.length - nErr ? 'checked' : ''}></th>
                    <th style="width:56px">列</th><th>資料</th><th style="width:42%">檢查結果</th></tr></thead>
                <tbody>${items.map((it, i) => `
                    <tr class="${it.errors.length ? 'row-err' : it.warnings.length ? 'row-warn' : ''}">
                        <td><input type="checkbox" data-i="${i}" ${it.include ? 'checked' : ''} ${it.errors.length ? 'disabled' : ''}></td>
                        <td class="mono muted">${esc(it.lineLabel || it.line)}</td>
                        <td><div class="csv-item-title">${esc(it.title)}</div>${it.sub ? `<div class="muted">${it.subHtml ? it.sub : esc(it.sub)}</div>` : ''}</td>
                        <td>${it.errors.map(e => `<div class="csv-msg err">✘ ${esc(e)}</div>`).join('')}
                            ${it.warnings.map(w => `<div class="csv-msg warn">⚠ ${esc(w)}</div>`).join('')}
                            ${!it.errors.length && !it.warnings.length ? '<div class="csv-msg ok">✔ 可匯入</div>' : ''}</td>
                    </tr>`).join('')}</tbody>
            </table></div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" data-act="repick">↺ 重新選擇檔案</button>
                <span style="flex:1"></span>
                <button type="button" class="btn btn-secondary" data-act="close">取消</button>
                <button type="button" class="btn btn-primary" data-act="go" ${nSel ? '' : 'disabled'}>確認匯入 ${nSel} 筆</button>
            </div>`;
        m.querySelectorAll('tbody input[data-i]').forEach(cb => cb.onchange = () => { items[cb.dataset.i].include = cb.checked; renderPreview(m, st); });
        const all = m.querySelector('#csvAll');
        if (all) all.onchange = () => { items.forEach(it => { if (!it.errors.length) it.include = all.checked; }); renderPreview(m, st); };
        const ad = m.querySelector('#csvAutoDict');
        if (ad) ad.onchange = () => { st.autoDict = ad.checked; buildItems(st); renderPreview(m, st); };
        m.querySelector('[data-act=repick]').onclick = () => { st.items = []; renderPick(m, st); };
        m.querySelector('[data-act=close]').onclick = () => PM.closeModal('csvImportModal');
        m.querySelector('[data-act=go]').onclick = () => doImport(m, st);
    }

    async function doImport(m, st) {
        if (st.busy) return;
        const sel = st.items.filter(i => i.include && !i.errors.length);
        if (!sel.length) return;
        if (!confirm(`確定匯入 ${sel.length} 筆資料？`)) return;
        st.busy = true;
        const btn = m.querySelector('[data-act=go]');
        const progress = (done, total) => { if (btn) btn.textContent = `匯入中… ${done}/${total}`; };
        const ok = await PM.act(async () => {
            const adds = sel.flatMap(i => i.dictAdds);
            if (adds.length) {
                const d = PM.getDicts();
                adds.forEach(([k, v]) => { if (!d[k].includes(v)) d[k].push(v); });
                await PM.api.saveDicts(d);
            }
            await st.spec.commit(sel, progress);
        }, st.spec.okMsg ? st.spec.okMsg(sel.length) : `已匯入 ${sel.length} 筆`);
        st.busy = false;
        if (ok) { PM.closeModal('csvImportModal'); if (st.spec.onDone) st.spec.onDone(sel); }
        else if (btn) btn.textContent = '重試匯入';
    }
})();
