import { pickedCompletion, snippet, startCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { api, type Symbols } from './api';

/**
 * LaTeX completion for the editor. Three kinds of thing are offered:
 *  - commands after a backslash: a built-in list plus the macros the paper defines;
 *  - environments inside \begin{ and \end{;
 *  - what belongs in a command's argument: the paper's labels in \ref{, its citation keys
 *    in \cite{, its files in \input{ and \includegraphics{, installed packages in \usepackage{.
 * The paper's own names come from the server (/api/symbols), which reads the files on disk.
 */

// ---------- built-in commands ----------
// One entry per word; each {} is a place to fill in, which Tab moves between.

/** Symbols, written name:glyph so the list can show what each one looks like. */
const SYMBOLS = `
alpha:α beta:β gamma:γ delta:δ epsilon:ϵ varepsilon:ε zeta:ζ eta:η theta:θ vartheta:ϑ iota:ι kappa:κ lambda:λ mu:μ nu:ν xi:ξ
pi:π varpi:ϖ rho:ρ varrho:ϱ sigma:σ varsigma:ς tau:τ upsilon:υ phi:ϕ varphi:φ chi:χ psi:ψ omega:ω
Gamma:Γ Delta:Δ Theta:Θ Lambda:Λ Xi:Ξ Pi:Π Sigma:Σ Upsilon:Υ Phi:Φ Psi:Ψ Omega:Ω
times:× cdot:⋅ pm:± mp:∓ div:÷ ast:∗ star:⋆ circ:∘ bullet:∙ oplus:⊕ otimes:⊗ ominus:⊖ odot:⊙ cap:∩ cup:∪ sqcup:⊔ vee:∨ wedge:∧
setminus:∖ leq:≤ le:≤ geq:≥ ge:≥ neq:≠ ne:≠ ll:≪ gg:≫ approx:≈ simeq:≃ sim:∼ cong:≅ equiv:≡ propto:∝ subset:⊂ supset:⊃
subseteq:⊆ supseteq:⊇ in:∈ notin:∉ ni:∋ perp:⊥ parallel:∥ mid:∣ nmid:∤ prec:≺ succ:≻ preceq:⪯ succeq:⪰ lesssim:≲ gtrsim:≳
to:→ rightarrow:→ leftarrow:← gets:← leftrightarrow:↔ Rightarrow:⇒ Leftarrow:⇐ Leftrightarrow:⇔ longrightarrow:⟶ longleftarrow:⟵
Longrightarrow:⟹ Longleftrightarrow:⟺ mapsto:↦ longmapsto:⟼ uparrow:↑ downarrow:↓ updownarrow:↕ hookrightarrow:↪ rightleftharpoons:⇌
nearrow:↗ searrow:↘ implies:⟹ iff:⟺ infty:∞ partial:∂ nabla:∇ forall:∀ exists:∃ nexists:∄ emptyset:∅ varnothing:∅ hbar:ℏ ell:ℓ
Re:ℜ Im:ℑ aleph:ℵ wp:℘ angle:∠ neg:¬ lnot:¬ top:⊤ bot:⊥ dagger:† ddagger:‡ prime:′ ldots:… cdots:⋯ vdots:⋮ ddots:⋱ dots:…
sum:∑ prod:∏ coprod:∐ int:∫ iint:∬ iiint:∭ oint:∮ bigcup:⋃ bigcap:⋂ bigoplus:⨁ bigotimes:⨂ bigvee:⋁ bigwedge:⋀ bigsqcup:⨆
langle:⟨ rangle:⟩ lfloor:⌊ rfloor:⌋ lceil:⌈ rceil:⌉ lVert:‖ rVert:‖ lvert:| rvert:| Vert:‖ vert:| triangle:△ square:□ Box:□
diamond:⋄ therefore:∴ because:∵ checkmark:✓ land:∧ lor:∨ vdash:⊢ dashv:⊣ models:⊨ ltimes:⋉ rtimes:⋊ wr:≀ asymp:≍ doteq:≐
triangleq:≜ coloneqq:≔ leadsto:⇝ imath:ı jmath:ȷ Vdash:⊩ subsetneq:⊊ supsetneq:⊋ nsubseteq:⊈ lessgtr:≶ backslash:\\
pounds:£ S:§ P:¶ copyright:© textdegree:° textbackslash:\\ textasciitilde:~ textbar:|
`;

const MATH = `
frac{}{} dfrac{}{} tfrac{}{} binom{}{} sqrt{} sqrt[]{} mathbb{} mathcal{} mathbf{} mathrm{} mathit{} mathsf{} mathtt{} mathfrak{} mathscr{}
boldsymbol{} bm{} text{} operatorname{} hat{} bar{} tilde{} vec{} dot{} ddot{} check{} breve{} acute{} grave{} widehat{} widetilde{}
overline{} underline{} overbrace{} underbrace{} overrightarrow{} overleftarrow{} overset{}{} underset{}{} stackrel{}{} substack{}
left right big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr Biggl Biggr middle quad qquad limits nolimits displaystyle textstyle
scriptstyle scriptscriptstyle not tag{} notag nonumber intertext{} shortintertext{} phantom{} vphantom{} hphantom{} boxed{}
xrightarrow{} xleftarrow{} cancel{} mathop{} mathrel{} mathbin{} mathord{} mathclap{} smash{} pmod{} bmod mod
sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh coth log ln lg exp lim liminf limsup max min sup inf det dim ker deg gcd
arg hom Pr
ket{} bra{} braket{}{} ketbra{}{} expval{} mel{}{}{} abs{} norm{} dv{}{} pdv{}{} comm{}{} acomm{}{} Tr tr dd qty{}{} unit{} num{}
SI{}{} si{} ensuremath{}
`;

const TEXT = `
documentclass{} usepackage{} RequirePackage{} begin{} end{} part{} chapter{} section{} subsection{} subsubsection{} paragraph{} subparagraph{}
title{} author{} date{} maketitle tableofcontents listoffigures listoftables appendix label{} ref{} eqref{} cref{} Cref{} autoref{}
pageref{} nameref{} cite{} citep{} citet{} citeauthor{} citeyear{} citealp{} citealt{} textcite{} parencite{} autocite{} footcite{}
nocite{} bibliography{} bibliographystyle{} addbibresource{} printbibliography bibitem{} footnote{} footnotemark footnotetext{}
emph{} textbf{} textit{} texttt{} textsc{} textsf{} textrm{} textup{} textsl{} textnormal{} textsuperscript{} textsubscript{}
textcolor{}{} color{} colorbox{}{} definecolor{}{}{} url{} href{}{} hyperref[]{} hypersetup{} includegraphics[width=\\linewidth]{}
includegraphics{} graphicspath{} caption{} captionsetup{} subcaption{} centering raggedright raggedleft item item[] input{}
include{} includeonly{} subfile{} newcommand{}{} renewcommand{}{} providecommand{}{} newenvironment{}{}{} renewenvironment{}{}{}
newtheorem{}{} theoremstyle{} DeclareMathOperator{}{} NewDocumentCommand{}{}{} hspace{} vspace{} hfill vfill hskip vskip newline
linebreak nolinebreak pagebreak nopagebreak newpage clearpage cleardoublepage noindent indent par smallskip medskip bigskip
tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge bfseries itshape scshape ttfamily sffamily rmfamily
mdseries upshape normalfont textwidth linewidth columnwidth textheight paperwidth paperheight columnsep parindent parskip
baselineskip tabcolsep arraystretch hline cline{} toprule midrule bottomrule cmidrule{} multicolumn{}{}{} multirow{}{}{} today
LaTeX TeX thanks{} affiliation{} email{} address{} keywords{} pacs{} preprint{} collaboration{} altaffiliation{} orcid{}
acknowledgments protect makeatletter makeatother setlength{}{} addtolength{}{} setcounter{}{} addtocounter{}{} stepcounter{}
refstepcounter{} numberwithin{}{} qedhere qed marginpar{} mbox{} makebox[]{} fbox{} framebox[]{} parbox{}{} raisebox{}{} rule{}{}
centerline{} geometry{} pagestyle{} thispagestyle{} pagenumbering{} linespread{} onecolumngrid twocolumngrid onecolumn twocolumn
verb usetikzlibrary{} tikzset{} draw node path fill coordinate foreach lstinline lstset{} lstinputlisting{} todo{} texorpdfstring{}{}
phantomsection addcontentsline{}{}{} enlargethispage{} sloppy fussy hyphenation{} newcolumntype{}{} newlength{} newcounter{}
arabic{} roman{} Roman{} alph{} Alph{} the value{} ifx fi else relax
`;

/** Environments, and what goes inside the ones that have a usual shape. */
const ENVS = `
document abstract equation equation* align align* gather gather* multline multline* flalign flalign* alignat alignat* split aligned
gathered alignedat cases dcases eqnarray eqnarray* subequations matrix pmatrix bmatrix vmatrix Bmatrix Vmatrix smallmatrix array
figure figure* table table* tabular tabular* tabularx longtable subfigure subtable wrapfigure itemize enumerate description center
flushleft flushright quote quotation verse verbatim verbatim* minipage theorem lemma proposition corollary definition proof remark
example conjecture claim thebibliography tikzpicture scope axis frame columns column block alertblock exampleblock lstlisting
minted algorithm algorithmic widetext acknowledgments appendix appendices titlepage tcolorbox landscape sidewaysfigure
sidewaystable comment filecontents displaymath math picture spacing multicols
`;

const figure = '[t]\n\t\\centering\n\t\\includegraphics[width=\\linewidth]{${}}\n\t\\caption{${}}\n\t\\label{fig:${}}';
const table =
  '[t]\n\t\\centering\n\t\\caption{${}}\n\t\\label{tab:${}}\n\t\\begin{tabular}{${cols}}\n\t\t\\hline\n\t\t${}\n\t\t\\hline\n\t\\end{tabular}';
const ENV_BODY: Record<string, string> = {
  figure,
  'figure*': figure,
  table,
  'table*': table,
  itemize: '\n\t\\item ${}',
  enumerate: '\n\t\\item ${}',
  description: '\n\t\\item[${}] ${}',
  tabular: '{${cols}}\n\t${}',
  array: '{${cols}}\n\t${}',
  tabularx: '{\\linewidth}{${cols}}\n\t${}',
  longtable: '{${cols}}\n\t${}',
  minipage: '{${width}}\n\t${}',
  subfigure: '{${width}}\n\t${}',
  subtable: '{${width}}\n\t${}',
  thebibliography: '{99}\n\t\\bibitem{${}} ${}',
  frame: '{${title}}\n\t${}',
  column: '{${width}}\n\t${}',
  multicols: '{${2}}\n\t${}',
  alignat: '{${2}}\n\t${}',
  'alignat*': '{${2}}\n\t${}',
};

const COMMON_PACKAGES = `
amsmath amssymb amsthm amsfonts mathtools bm physics braket siunitx graphicx xcolor color hyperref cleveref natbib biblatex geometry
inputenc fontenc babel microtype booktabs tabularx multirow longtable array caption subcaption float enumitem tikz pgfplots listings
minted algorithm algorithmic algorithm2e algpseudocode url csquotes setspace fancyhdr titlesec appendix authblk lineno todonotes
soul ulem cancel dsfont bbm mathrsfs upgreek tensor slashed feynmp-auto tikz-feynman revtex4-2 thmtools tcolorbox mdframed
placeins rotating pdflscape wrapfig epstopdf textcomp lmodern times newtxtext newtxmath mathpazo fontspec unicode-math
`;
const COMMON_CLASSES = 'article report book letter revtex4-2 revtex4-1 amsart beamer memoir scrartcl scrreprt scrbook standalone IEEEtran elsarticle llncs acmart quantumarticle iopart mnras aastex631 svjour3 jheppub';

const words = (s: string) => s.split(/\s+/).filter(Boolean);

// ---------- which commands take what in their argument ----------

type ArgKind = 'label' | 'cite' | 'package' | 'class' | 'tex' | 'bib' | 'graphics' | 'begin' | 'end';

function argKind(cmd: string): ArgKind | null {
  if (cmd === 'begin' || cmd === 'end') return cmd;
  if (/^(eq|c|C|auto|page|name|v|V|f|F|sub|labelc|labelC)?ref$|^[cC]refrange$|^hyperref$/.test(cmd)) return 'label';
  if (/cite/i.test(cmd)) return 'cite';
  if (cmd === 'usepackage' || cmd === 'RequirePackage') return 'package';
  if (cmd === 'documentclass' || cmd === 'LoadClass') return 'class';
  if (cmd === 'input' || cmd === 'include' || cmd === 'includeonly' || cmd === 'subfile') return 'tex';
  if (cmd === 'bibliography' || cmd === 'addbibresource') return 'bib';
  if (cmd === 'includegraphics') return 'graphics';
  return null;
}

// ---------- applying a completion ----------

/** Inserts a command. `template` is the text after the backslash, with {} for each place to fill in. */
function command(name: string, template: string, extra: Partial<Completion>): Completion {
  const takesList = template === `${name}{}` && argKind(name) !== null;
  const filled = snippet(`\\\\${template.replace(/\{\}/g, '{${}}').replace(/\[\]/g, '[${}]')}`.replace(/^\\\\/, '\\'));
  return {
    label: `\\${name}`,
    // Shown when two entries share a name (\sqrt and \sqrt[]).
    ...(template !== name && template !== `${name}{}` ? { displayLabel: `\\${template}` } : {}),
    ...extra,
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      // Renaming a command that already has its argument: leave the argument alone.
      if (template === name || view.state.sliceDoc(to, to + 1) === '{') {
        view.dispatch({ changes: { from, to, insert: `\\${name}` }, selection: { anchor: from + name.length + 1 }, annotations: pickedCompletion.of(completion), userEvent: 'input.complete' });
      } else if (takesList) {
        // \cite{|}: go straight on to offering what belongs between the braces.
        view.dispatch({ changes: { from, to, insert: `\\${name}{}` }, selection: { anchor: from + name.length + 2 }, annotations: pickedCompletion.of(completion), userEvent: 'input.complete' });
        startCompletion(view);
      } else {
        filled(view, completion, from, to);
      }
    },
  };
}

/** Fills in an environment name after \begin{, with the matching \end and the usual contents. */
function environment(name: string, boost = 0): Completion {
  return {
    label: name,
    type: 'type',
    boost,
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      const closed = view.state.sliceDoc(to, to + 1) === '}';
      const end = closed ? to + 1 : to;
      const rest = view.state.doc.lineAt(end).to;
      const after = view.state.sliceDoc(end, rest);
      // Only on a fresh \begin{}: anything after it means an existing environment is being renamed.
      if (after.trim() === '') {
        snippet(`${name}}${ENV_BODY[name] ?? '\n\t${}'}\n\\end{${name}}`)(view, completion, from, rest);
      } else {
        view.dispatch({ changes: { from, to, insert: name }, selection: { anchor: from + name.length + (closed ? 1 : 0) }, annotations: pickedCompletion.of(completion), userEvent: 'input.complete' });
      }
    },
  };
}

/** Fills in a name inside braces, and steps over the closing brace when that finishes the argument. */
function closing(name: string, extra: Partial<Completion>): Completion {
  return {
    label: name,
    ...extra,
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      const closed = view.state.sliceDoc(to, to + 1) === '}';
      view.dispatch({
        changes: { from, to, insert: closed ? name : `${name}}` },
        selection: { anchor: from + name.length + 1 },
        annotations: pickedCompletion.of(completion),
        userEvent: 'input.complete',
      });
    },
  };
}

// ---------- the lists ----------

const BUILTIN: Completion[] = [
  ...words(SYMBOLS).map((w) => {
    const [name, glyph] = w.split(':');
    // Ahead of rarer commands that start the same way: \alpha before \alph, \int before \intertext.
    return command(name, name, { type: 'constant', detail: glyph, boost: 2 });
  }),
  ...words(MATH).map((w) => command(w.replace(/[[{].*/, ''), w, { type: 'function' })),
  ...words(TEXT).map((w) => command(w.replace(/[[{].*/, ''), w, { type: 'keyword' })),
];
const BUILTIN_NAMES = new Set(BUILTIN.map((c) => c.label));
const ENV_NAMES = words(ENVS);

const EMPTY: Symbols = { labels: [], cites: [], macros: [], envs: [], tex: [], bib: [], graphics: [] };
let symbols: { at: number; value: Promise<Symbols> } | null = null;

/** The paper's own names. Asked for again after a couple of seconds, so new labels and references turn up as they are written. */
function projectSymbols(): Promise<Symbols> {
  if (!symbols || Date.now() - symbols.at > 2000) symbols = { at: Date.now(), value: api.symbols().catch(() => EMPTY) };
  return symbols.value;
}

let installed: Promise<{ packages: Completion[]; classes: Completion[] }> | null = null;

function texInstalled() {
  installed ??= api
    .texInstalled()
    .catch(() => ({ packages: [], classes: [] }))
    .then((tex) => {
      // The installation's full list, with the ones most papers use first.
      const list = (all: string[], common: string[]) => {
        const first = new Set(common);
        return [...new Set([...common.filter((c) => !all.length || all.includes(c)), ...all])].map((name) => ({ label: name, type: 'namespace', boost: first.has(name) ? 10 : 0 }));
      };
      return { packages: list(tex.packages, words(COMMON_PACKAGES)), classes: list(tex.classes, words(COMMON_CLASSES)) };
    });
  return installed;
}

/** Environments still open at this point, innermost first. */
function openEnvironments(before: string): string[] {
  const stack: string[] = [];
  for (const m of before.matchAll(/\\(begin|end)\{([^{}]+)\}/g)) {
    if (m[1] === 'begin') stack.push(m[2]);
    else if (stack.lastIndexOf(m[2]) >= 0) stack.length = stack.lastIndexOf(m[2]);
  }
  return stack.reverse();
}

const NAME = /^[^{},\s\\]*$/;

export async function latexCompletion(context: CompletionContext): Promise<CompletionResult | null> {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  if (/(^|[^\\])%/.test(before)) return null; // In a comment.

  // Inside a command's argument: \cite[p. 3]{one, tw|
  const arg = /\\([a-zA-Z]+)\*?(?:\[[^\]]*\])*\{([^{}]*)$/.exec(before);
  // Any other command's argument is ordinary LaTeX, where commands are completed as usual: \ket{\psi}.
  const kind = arg && argKind(arg[1]);
  if (arg && kind) {
    const part = /[^,\s]*$/.exec(arg[2])![0];
    const from = pos - part.length;

    if (kind === 'begin' || kind === 'end') {
      const sym = await projectSymbols();
      if (context.aborted) return null;
      const names = [...new Set([...ENV_NAMES, ...sym.envs])];
      if (kind === 'begin') return { from, options: names.map((n) => environment(n, sym.envs.includes(n) ? 5 : 0)), validFor: NAME };
      const open = openEnvironments(state.sliceDoc(Math.max(0, pos - 20000), line.from) + before.slice(0, arg.index));
      const all = [...new Set([...open, ...names])];
      return { from, options: all.map((n) => closing(n, { type: 'type', boost: open.includes(n) ? 50 - open.indexOf(n) : 0 })), validFor: NAME };
    }
    if (kind === 'package' || kind === 'class') {
      const tex = await texInstalled();
      if (context.aborted) return null;
      return { from, options: kind === 'package' ? tex.packages : tex.classes, validFor: NAME };
    }
    const sym = await projectSymbols();
    if (context.aborted) return null;
    let options: Completion[];
    if (kind === 'label') {
      options = sym.labels.map((l) => ({ label: l.name, type: 'variable', detail: `${l.file.split('/').pop()}:${l.line}` }));
    } else if (kind === 'cite') {
      // Matched against author, year and title as well as the key, so "\cite{einstein" finds the paper.
      options = sym.cites.map((c) => ({ label: c.detail ? `${c.key} ${c.detail}` : c.key, displayLabel: c.key, apply: c.key, type: 'text', detail: c.detail }));
    } else {
      const ext = kind === 'bib' && arg[1] === 'addbibresource' ? '.bib' : '';
      options = sym[kind].map((f) => ({ label: f + ext, type: 'text' }));
    }
    return options.length ? { from, options, validFor: kind === 'cite' ? /^[^{},\\]*$/ : NAME } : null;
  }

  // A command: an odd number of backslashes, then letters. (\\ is a line break, not the start of one.)
  const cmd = /(\\+)([a-zA-Z@]*)$/.exec(before);
  if (!cmd || cmd[1].length % 2 === 0) return null;
  const sym = await projectSymbols();
  if (context.aborted) return null;
  const own = sym.macros
    .filter((m) => !BUILTIN_NAMES.has(`\\${m.name}`))
    .map((m) => command(m.name, m.name + '{}'.repeat(m.args), { type: 'variable', detail: 'this paper', boost: 5 }));
  return { from: pos - cmd[2].length - 1, options: [...own, ...BUILTIN], validFor: /^\\[a-zA-Z@]*$/ };
}
