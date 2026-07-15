import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { copyText } from "../lib/api";
import { tokenize, toggleLineComment, quoteSqlIdent } from "../lib/sql";
import { menuPos } from "../lib/menuPos";
import { SQL_FUNCTION_GROUPS, applySnippet } from "../lib/sqlFunctions";
import type { TableInfo } from "../lib/types";
import { useRenderCount } from "../lib/renderDebug";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRunAll: (sql: string) => void;
  onRunStatement: (pos: number) => void;
  /** live caret + selection, for the toolbar's Run / Statement buttons */
  caretRef?: React.MutableRefObject<{ start: number; end: number }>;
  placeholder?: string;
  // schema for autocomplete (table + column names)
  tables?: TableInfo[];
  /** .459: one-shot highlight of the statement that just ran */
  flash?: { start: number; end: number; kind?: "err";
            tick: number } | null;
  /** .460: nonzero after a successful Format -- plays a shimmer */
  fmtShimmer?: number;
  /** .462: a SELECTION run hands its range up so it can flash too */
  onRunSelection?: (start: number, end: number) => void;
  /** Stable rendered hook. IDE and Journal editors must not share one id. */
  testId?: string;
}

const TOKEN_CLASS: Record<string, string> = {
  keyword: "t-keyword",
  function: "t-function",
  string: "t-string",
  number: "t-number",
  comment: "t-comment",
  ident: "t-ident",
  punct: "t-punct",
  ws: "",
};

// A compact set of SQL keywords offered by autocomplete (uppercased on insert).
const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT",
  "OFFSET", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN",
  "FULL JOIN", "CROSS JOIN", "ON", "USING", "AS", "AND", "OR", "NOT",
  "NULL", "IS NULL", "IS NOT NULL", "IN", "LIKE", "BETWEEN", "EXISTS",
  "DISTINCT", "ALL", "UNION", "UNION ALL", "INTERSECT", "EXCEPT", "CASE",
  "WHEN", "THEN", "ELSE", "END", "CAST", "COALESCE", "NULLIF", "WITH",
  "RECURSIVE", "ASC", "DESC", "COUNT", "SUM", "AVG", "MIN", "MAX", "ROUND",
  "ABS", "LENGTH", "LOWER", "UPPER", "TRIM", "SUBSTR", "REPLACE", "DATE",
  "STRFTIME", "OVER", "PARTITION BY", "ROW_NUMBER", "RANK", "DENSE_RANK",
  "TRUE", "FALSE",
];

type SugKind = "table" | "col" | "kw";
interface Sug {
  text: string;
  kind: SugKind;
}
interface Menu {
  items: Sug[];
  index: number;
  left: number;
  top: number;
}

const KIND_LABEL: Record<SugKind, string> = {
  table: "table",
  col: "col",
  kw: "kw",
};

export const SqlEditor: React.FC<Props> = ({
  value,
  onChange,
  onRunAll,
  onRunStatement,
  flash,
  fmtShimmer,
  onRunSelection,
  caretRef,
  placeholder,
  tables = [] as TableInfo[],
  testId = "sql-editor",
}) => {
  useRenderCount("SqlEditor");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const blurTimer = useRef<number | null>(null);

  const [menu, setMenu] = useState<Menu | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // anchor for the "SQL functions" submenu (right edge of its menu item)
  const [fnMenu, setFnMenu] = useState<{ x: number; y: number } | null>(null);

  // schema vocab, recomputed only when the table list changes
  const tableNames = useMemo(
    () => tables.map((t) => t.name).filter(Boolean),
    [tables],
  );
  const allColumns = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of tables)
      for (const c of t.columns || [])
        if (c.name && !seen.has(c.name.toLowerCase())) {
          seen.add(c.name.toLowerCase());
          out.push(c.name);
        }
    return out;
  }, [tables]);

  const lineCount = useMemo(
    () => Math.max(1, value.split("\n").length),
    [value],
  );

  const activeLine = useMemo(() => {
    const ta = taRef.current;
    if (!ta) return 1;
    const pos = ta.selectionStart ?? 0;
    return value.slice(0, pos).split("\n").length;
  }, [value]);

  const highlighted = useMemo(() => {
    const tokens = tokenize(value);
    return tokens.map((t, idx) => {
      const cls = TOKEN_CLASS[t.kind] || "";
      if (!cls) return <span key={idx}>{t.text}</span>;
      return (
        <span key={idx} className={cls}>
          {t.text}
        </span>
      );
    });
  }, [value]);

  const flashPreRef = useRef<HTMLPreElement | null>(null);

  // .460: when the caret lands on a bracket, pulse it and its match.
  const [bkt, setBkt] = useState<{ a: number; b: number;
                                   tick: number } | null>(null);
  const bktLast = useRef<number>(-1);
  const OPEN = "([{";
  const CLOSE = ")]}";
  const matchBracket = (text: string, pos: number) => {
    const at = (i: number) => text[i] || "";
    let i = -1;
    if (OPEN.includes(at(pos)) || CLOSE.includes(at(pos))) i = pos;
    else if (OPEN.includes(at(pos - 1)) || CLOSE.includes(at(pos - 1)))
      i = pos - 1;
    if (i < 0) return null;
    const ch = at(i);
    const open = OPEN.includes(ch);
    const pair = open
      ? CLOSE[OPEN.indexOf(ch)]
      : OPEN[CLOSE.indexOf(ch)];
    let depth = 0;
    if (open) {
      for (let j = i; j < text.length && j < i + 20000; j++) {
        if (text[j] === ch) depth++;
        else if (text[j] === pair && --depth === 0)
          return { a: i, b: j };
      }
    } else {
      for (let j = i; j >= 0 && j > i - 20000; j--) {
        if (text[j] === ch) depth++;
        else if (text[j] === pair && --depth === 0)
          return { a: j, b: i };
      }
    }
    return null;
  };
  const pulseBrackets = (pos: number) => {
    if (pos === bktLast.current) return;
    bktLast.current = pos;
    const m = matchBracket(value, pos);
    setBkt(m ? { ...m, tick: Date.now() } : null);
  };

  const syncScroll = useCallback(() => {
    const sc = scrollRef.current;
    const ta = taRef.current;
    // If the textarea scrolled internally (should not, with overflow:hidden),
    // fold that into .scroll so the highlight transform stays aligned.
    if (sc && ta && (ta.scrollLeft || ta.scrollTop)) {
      sc.scrollLeft += ta.scrollLeft;
      sc.scrollTop += ta.scrollTop;
      ta.scrollLeft = 0;
      ta.scrollTop = 0;
    }
    const g = gutterRef.current;
    if (sc && g) g.scrollTop = sc.scrollTop;
    const pre = preRef.current;
    const tf = sc
      ? `translate(${-sc.scrollLeft}px, ${-sc.scrollTop}px)`
      : "";
    if (sc && pre) pre.style.transform = tf;
    // .459: the flash layer rides the exact same transform.
    const fp = flashPreRef.current;
    if (sc && fp) fp.style.transform = tf;
  }, []);

  // measure monospace character width once (cached on the canvas ref)
  const charWidth = (ta: HTMLTextAreaElement): number => {
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return 7.8;
    const cs = getComputedStyle(ta);
    ctx.font = cs.font || `${cs.fontSize} ${cs.fontFamily}`;
    const w = ctx.measureText("0").width;
    return w > 0 ? w : 7.8;
  };

  /** Pixel width of the longest line (tabs expanded to tab-size 2). */
  const maxLineWidthPx = (ta: HTMLTextAreaElement, text: string): number => {
    if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
    const ctx = canvasRef.current.getContext("2d");
    const cs = getComputedStyle(ta);
    if (ctx) ctx.font = cs.font || `${cs.fontSize} ${cs.fontFamily}`;
    const cw = charWidth(ta);
    let max = 0;
    for (const line of text.split("\n")) {
      const expanded = line.replace(/\t/g, "  ");
      const w = ctx ? ctx.measureText(expanded).width : expanded.length * cw;
      if (w > max) max = w;
    }
    const pad =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    return Math.ceil(max + pad + 2);
  };

  useLayoutEffect(() => {
    // .424 / long-line fix: the textarea is the scroll extent of .scroll
    // (the highlight <pre> is an absolute overlay and sizes nothing).
    // Relying on pre.scrollWidth alone is unreliable for absolute+inset
    // overlays — long single-line SQL then never widens the scroller and
    // the highlight clips. Measure the real content width (and height)
    // and size the textarea so .scroll can reach every character.
    const ta = taRef.current;
    const pre = preRef.current;
    if (ta && pre) {
      const cs = getComputedStyle(ta);
      const lineH = parseFloat(cs.lineHeight) || 20;
      const padY =
        (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const contentW = Math.max(maxLineWidthPx(ta, value), pre.scrollWidth);
      ta.style.minWidth = contentW + "px";
      ta.style.minHeight = Math.ceil(lineCount * lineH + padY) + "px";
    }
    syncScroll();
  }, [value, lineCount, syncScroll]);

  const closeMenu = useCallback(() => setMenu(null), []);

  // recompute suggestions from the current caret; positions the dropdown
  const refresh = useCallback(
    (ta: HTMLTextAreaElement) => {
      const pos = ta.selectionStart ?? 0;
      if (pos !== (ta.selectionEnd ?? 0)) {
        setMenu(null);
        return;
      }
      const val = ta.value;
      const before = val.slice(0, pos);

      let prefix = "";
      let items: Sug[] = [];
      const dot = before.match(/([A-Za-z_]\w*)\.(\w*)$/);
      if (dot) {
        prefix = dot[2];
        const tname = dot[1].toLowerCase();
        const t = tables.find((x) => x.name.toLowerCase() === tname);
        const cols = t ? (t.columns || []).map((c) => c.name) : allColumns;
        const p = prefix.toLowerCase();
        items = cols
          .filter((c) => c.toLowerCase().startsWith(p))
          .map((c) => ({ text: c, kind: "col" as SugKind }));
      } else {
        const w = before.match(/(\w+)$/);
        if (!w) {
          setMenu(null);
          return;
        }
        prefix = w[1];
        // wait until there's at least one char of an identifier
        if (!/[A-Za-z_]/.test(prefix[0])) {
          setMenu(null);
          return;
        }
        const p = prefix.toLowerCase();
        const tHit: Sug[] = tableNames
          .filter((n) => n.toLowerCase().startsWith(p))
          .map((n) => ({ text: n, kind: "table" }));
        const cHit: Sug[] = allColumns
          .filter((c) => c.toLowerCase().startsWith(p))
          .map((c) => ({ text: c, kind: "col" }));
        const kHit: Sug[] = KEYWORDS.filter((k) =>
          k.toLowerCase().startsWith(p),
        ).map((k) => ({ text: k, kind: "kw" }));
        const seen = new Set<string>();
        for (const s of [...tHit, ...cHit, ...kHit]) {
          const key = s.text.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            items.push(s);
          }
        }
      }

      if (!items.length) {
        setMenu(null);
        return;
      }
      // nothing to add if the only match equals what's already typed
      if (
        items.length === 1 &&
        items[0].text.toLowerCase() === prefix.toLowerCase()
      ) {
        setMenu(null);
        return;
      }
      items = items.slice(0, 9);

      // caret pixel position (monospace, white-space: pre -> no wrapping)
      const scroll = scrollRef.current;
      const code = scroll?.parentElement;
      if (!scroll || !code) {
        setMenu(null);
        return;
      }
      const cs = getComputedStyle(ta);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padT = parseFloat(cs.paddingTop) || 0;
      const lineH = parseFloat(cs.lineHeight) || 20;
      const cw = charWidth(ta);
      const lineStart = before.lastIndexOf("\n") + 1;
      const caretCol = pos - lineStart;
      const caretLine = before.split("\n").length - 1;

      let left =
        scroll.offsetLeft + padL + caretCol * cw - scroll.scrollLeft;
      let top =
        scroll.offsetTop +
        padT +
        (caretLine + 1) * lineH -
        scroll.scrollTop;

      const codeW = code.clientWidth;
      const codeH = code.clientHeight;
      const menuW = 230;
      const menuH = Math.min(items.length, 9) * 26 + 8;
      if (left + menuW > codeW) left = Math.max(2, codeW - menuW - 4);
      if (left < 0) left = 2;
      // flip above the caret line if it would overflow the bottom
      if (top + menuH > codeH) {
        top =
          scroll.offsetTop +
          padT +
          caretLine * lineH -
          scroll.scrollTop -
          menuH;
        if (top < 0) top = 2;
      }

      setMenu({ items, index: 0, left, top });
    },
    [tables, tableNames, allColumns],
  );

  // insert the chosen suggestion, replacing the trailing identifier
  const accept = useCallback(
    (sug: Sug) => {
      const ta = taRef.current;
      if (!ta) return;
      const pos = ta.selectionStart ?? 0;
      const val = ta.value;
      const before = val.slice(0, pos);
      const m = before.match(/(\w+)$/);
      const start = m ? pos - m[1].length : pos;
      // Tables/columns that aren't bare-safe (spaces, dots, parens, …) must
      // land quoted so IDE + Journal autocomplete never produce broken SQL.
      // Keywords stay as typed (already uppercased identifiers).
      const inserted =
        sug.kind === "table" || sug.kind === "col"
          ? quoteSqlIdent(sug.text)
          : sug.text;
      const next = val.slice(0, start) + inserted + val.slice(pos);
      const caret = start + inserted.length;
      setMenu(null);
      onChange(next);
      requestAnimationFrame(() => {
        const t = taRef.current;
        if (t) {
          t.focus();
          t.selectionStart = t.selectionEnd = caret;
        }
      });
    },
    [onChange],
  );

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;

    // ---- autocomplete navigation takes priority while the menu is open ----
    if (menu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenu((mn) =>
          mn ? { ...mn, index: (mn.index + 1) % mn.items.length } : mn,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenu((mn) =>
          mn
            ? {
                ...mn,
                index: (mn.index - 1 + mn.items.length) % mn.items.length,
              }
            : mn,
        );
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
      // Enter / Tab accept the highlighted suggestion (but Ctrl/Cmd+Enter runs)
      if (
        (e.key === "Enter" && !e.metaKey && !e.ctrlKey) ||
        e.key === "Tab"
      ) {
        e.preventDefault();
        accept(menu.items[menu.index]);
        return;
      }
    }

    // .538: toggle "--" line comments -> Ctrl/Cmd + /
    if ((e.metaKey || e.ctrlKey) && (e.key === "/" || e.code === "Slash")) {
      e.preventDefault();
      setMenu(null);
      const res = toggleLineComment(
        value,
        ta.selectionStart,
        ta.selectionEnd,
      );
      onChange(res.text);
      requestAnimationFrame(() => {
        ta.selectionStart = res.selStart;
        ta.selectionEnd = res.selEnd;
      });
      return;
    }

    // Run whole editor (or selection) -> Ctrl/Cmd + Enter
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      setMenu(null);
      const sel = value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel.trim() && onRunSelection)
        onRunSelection(ta.selectionStart, ta.selectionEnd);
      else onRunAll(sel.trim() ? sel : value);
      return;
    }
    // Run statement at cursor -> F5
    if (e.key === "F5") {
      e.preventDefault();
      setMenu(null);
      onRunStatement(ta.selectionStart ?? 0);
      return;
    }
    // Indent with spaces
    if (e.key === "Tab") {
      e.preventDefault();
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      const next = value.slice(0, s) + "  " + value.slice(en);
      onChange(next);
      requestAnimationFrame(() => {
        if (taRef.current) {
          taRef.current.selectionStart = taRef.current.selectionEnd = s + 2;
        }
      });
      return;
    }
  };

  // keep a trailing newline visible in the highlight layer
  const trailing = value.endsWith("\n") ? " " : "";

  // ---- right-click context-menu actions ----
  const ctxRun = () => {
    setCtxMenu(null);
    const ta = taRef.current;
    const selTxt = ta ? value.slice(ta.selectionStart, ta.selectionEnd) : "";
    onRunAll(selTxt.trim() ? selTxt : value);
  };
  const ctxRunStatement = () => {
    setCtxMenu(null);
    onRunStatement(taRef.current?.selectionStart ?? 0);
  };
  const writeClip = (text: string) => {
    void copyText(text);
  };
  const ctxCopy = () => {
    setCtxMenu(null);
    const ta = taRef.current;
    if (!ta) return;
    const text =
      ta.selectionStart !== ta.selectionEnd
        ? value.slice(ta.selectionStart, ta.selectionEnd)
        : value;
    writeClip(text);
  };
  const ctxCut = () => {
    setCtxMenu(null);
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    if (s === e) return;
    writeClip(value.slice(s, e));
    onChange(value.slice(0, s) + value.slice(e));
    requestAnimationFrame(() => {
      if (taRef.current) {
        taRef.current.focus();
        taRef.current.selectionStart = taRef.current.selectionEnd = s;
      }
    });
  };
  const ctxPaste = async () => {
    setCtxMenu(null);
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    let clip = "";
    try {
      clip = await navigator.clipboard.readText();
    } catch {
      return; // clipboard read blocked
    }
    if (!clip) return;
    onChange(value.slice(0, s) + clip + value.slice(e));
    requestAnimationFrame(() => {
      if (taRef.current) {
        const p = s + clip.length;
        taRef.current.focus();
        taRef.current.selectionStart = taRef.current.selectionEnd = p;
      }
    });
  };
  const ctxSelectAll = () => {
    setCtxMenu(null);
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      ta.select();
    }
  };
  // Insert a SQL-function snippet at the caret (replacing any selection) and
  // place the cursor at the snippet's "$0" marker.
  const insertFn = (snippet: string) => {
    const ta = taRef.current;
    setCtxMenu(null);
    setFnMenu(null);
    if (!ta) return;
    const { text, caret } = applySnippet(
      value,
      ta.selectionStart ?? value.length,
      ta.selectionEnd ?? value.length,
      snippet,
    );
    onChange(text);
    requestAnimationFrame(() => {
      const t = taRef.current;
      if (t) {
        t.focus();
        t.selectionStart = t.selectionEnd = caret;
      }
    });
  };
  const hasSelection = (() => {
    const ta = taRef.current;
    return !!ta && ta.selectionStart !== ta.selectionEnd;
  })();

  return (
    <div className="code">
      <div className="gutter" ref={gutterRef}>
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className={"ln" + (i + 1 === activeLine ? " active" : "")}>
            {i + 1}
          </div>
        ))}
      </div>
      <div className="scroll" ref={scrollRef} onScroll={syncScroll}>
        <pre className="hl" ref={preRef} aria-hidden="true">
          {highlighted}
          {trailing}
        </pre>
        {flash &&
          flash.end > flash.start &&
          flash.start >= 0 &&
          flash.end <= value.length && (
            <pre
              className="hl flash-layer"
              ref={flashPreRef}
              aria-hidden="true"
              key={flash.tick}
              style={{
                transform: scrollRef.current
                  ? `translate(${-scrollRef.current.scrollLeft}px, ${-scrollRef
                      .current.scrollTop}px)`
                  : undefined,
              }}
            >
              {value.slice(0, flash.start)}
              <span
                className={
                  "run-flash" + (flash.kind === "err" ? " err" : "")
                }
              >
                {value.slice(flash.start, flash.end)}
              </span>
              {value.slice(flash.end)}
            </pre>
          )}
        {fmtShimmer ? (
          <div key={fmtShimmer} className="fmt-shimmer" aria-hidden />
        ) : null}
        {bkt && bkt.b < value.length && (
          <pre
            className="hl flash-layer"
            aria-hidden="true"
            key={"b" + bkt.tick}
            style={{
              transform: scrollRef.current
                ? `translate(${-scrollRef.current.scrollLeft}px, ${-scrollRef
                    .current.scrollTop}px)`
                : undefined,
            }}
          >
            {value.slice(0, bkt.a)}
            <span className="bkt">{value[bkt.a]}</span>
            {value.slice(bkt.a + 1, bkt.b)}
            <span className="bkt">{value[bkt.b]}</span>
            {value.slice(bkt.b + 1)}
          </pre>
        )}
        <textarea
          ref={taRef}
          className="ta"
          data-testid={testId}
          value={value}
          onSelect={(e) => {
            const _t = e.target as HTMLTextAreaElement;
            if (_t.selectionStart === _t.selectionEnd)
              pulseBrackets(_t.selectionStart);
            else setBkt(null);
            if (caretRef) {
              const t = e.target as HTMLTextAreaElement;
              caretRef.current = {
                start: t.selectionStart ?? 0,
                end: t.selectionEnd ?? 0,
              };
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={placeholder}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
            setCtxMenu({ x: e.clientX, y: e.clientY });
          }}
          onChange={(e) => {
            onChange(e.target.value);
            refresh(e.currentTarget);
          }}
          onKeyDown={handleKey}
          onScroll={syncScroll}
          onClick={(e) => {
            syncScroll();
            refresh(e.currentTarget);
          }}
          onKeyUp={syncScroll}
          onBlur={() => {
            // delay so a mousedown on a suggestion can run first
            if (blurTimer.current) window.clearTimeout(blurTimer.current);
            blurTimer.current = window.setTimeout(() => setMenu(null), 140);
          }}
        />
      </div>

      {menu && (
        <div
          className="ac-menu"
          style={{ left: menu.left, top: menu.top }}
          // keep textarea focus when clicking a suggestion
          onMouseDown={(e) => e.preventDefault()}
        >
          {menu.items.map((s, i) => (
            <div
              key={s.kind + ":" + s.text}
              className={"ac-item" + (i === menu.index ? " active" : "")}
              onMouseEnter={() =>
                setMenu((mn) => (mn ? { ...mn, index: i } : mn))
              }
              onMouseDown={(e) => {
                e.preventDefault();
                accept(s);
              }}
            >
              <span className="ac-text">{s.text}</span>
              <span className={"ac-kind ac-" + s.kind}>
                {KIND_LABEL[s.kind]}
              </span>
            </div>
          ))}
        </div>
      )}
      {ctxMenu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 130 }}
            onMouseDown={() => {
              setCtxMenu(null);
              setFnMenu(null);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
              setFnMenu(null);
            }}
          />
          <div
            className="ctx-menu"
            style={{ ...menuPos(ctxMenu.x, ctxMenu.y, 210), zIndex: 131 }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button onMouseDown={ctxRun} onMouseEnter={() => setFnMenu(null)}>
              Run query
            </button>
            <button
              onMouseDown={ctxRunStatement}
              onMouseEnter={() => setFnMenu(null)}
            >
              Run statement at cursor
            </button>
            <div className="sep" />
            <button
              className="has-sub"
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setFnMenu({ x: r.right - 3, y: r.top });
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                setFnMenu((m) => (m ? null : { x: r.right - 3, y: r.top }));
              }}
            >
              <span>SQL functions</span>
              <span className="chev">▸</span>
            </button>
            <div className="sep" />
            <button onMouseDown={ctxCopy} onMouseEnter={() => setFnMenu(null)}>
              Copy
            </button>
            <button
              onMouseDown={ctxCut}
              onMouseEnter={() => setFnMenu(null)}
              disabled={!hasSelection}
            >
              Cut
            </button>
            <button onMouseDown={ctxPaste} onMouseEnter={() => setFnMenu(null)}>
              Paste
            </button>
            <div className="sep" />
            <button
              onMouseDown={ctxSelectAll}
              onMouseEnter={() => setFnMenu(null)}
            >
              Select all
            </button>
          </div>
          {fnMenu && (
            <div
              className="ctx-menu fn-sub"
              style={{ ...menuPos(fnMenu.x, fnMenu.y, 252), zIndex: 132 }}
              onMouseDown={(e) => e.preventDefault()}
            >
              {SQL_FUNCTION_GROUPS.map((g) => (
                <div className="fn-group" key={g.title}>
                  <div className="label">{g.title}</div>
                  {g.items.map((fn) => (
                    <button
                      key={fn.label}
                      title={fn.hint || fn.snippet}
                      onMouseDown={() => insertFn(fn.snippet)}
                    >
                      {fn.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
