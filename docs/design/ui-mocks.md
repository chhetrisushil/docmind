# DocMind UI mocks: implementation reference

Source: Claude Design export (design system "Nocturne", Phosphor icons 2.1.1, React-based mocks).
Brief: `docs/design/claude-design-brief.md`. Spec: `docs/specs/2026-10-18-docmind-design.md` §7.
This file records what the mocks actually contain, not what the brief asked for. Values are exact
unless marked "approx". Mock components are React; the app uses Lit (`dm-*` wrappers).

The export has three artefacts: a token/component stylesheet (dark only), a **component sheet** (one
frame, dark/light prop) and a **screens** file (props: `screen` auth|chat|library|detail, `state`,
`theme`, `device` desktop|tablet). Frames are parametric, so every state below is a prop combination.

## 1. Screens and states present

| Brief item | In mocks | States present |
|---|---|---|
| 1 Sign in / Sign up | Yes | `signin`, `error` (bad credentials), `signup` |
| 2 App shell (sidebar / main / right panel) | Yes | Sidebar: populated, empty ("No chats yet..."), search active; panel open/closed |
| 3 Chat | Yes | `empty`, `searching`, `streaming`, `answered`, `search` (sidebar filter), `model-error`, `no-sources` |
| 4 Document library | Yes | `populated`, `empty`, `selected` (multi-select + drag-over + toast) |
| 5 Document detail | Yes | `summary`, `analysis`, `content` (PDF text), `content-image` (image + OCR text) |
| 6 Account settings | **MISSING** | No profile screen, no sign-out control, no "Delete my account" flow |
| Confirmation dialog (component list) | **MISSING** | Only CSS (`.dialog`, `.dialog-backdrop`) in the token file; no frame uses it |
| Rename session (hover action) | Partial | Pencil/trash icons shown on hover; no inline-rename or delete-confirm state |
| Scope picker | Partial | Seg control + chips on empty chat, and a composer scope button with caret; **no dropdown/popover or document-picker state** |
| Table-row actions menu | Partial | `...` button only; no menu |
| Type / status filter menus | Partial | Buttons with caret; no open menu |

All states are rendered in dark and light and at 1440x900 and 1024x768 (device prop).

Extras the mocks added (not in the brief):
- Sign-in/up two-column layout with a marketing panel showing a sample cited answer (desktop only).
- "Forgot password?" link, show-password toggle, sign-up "Full name" and "Workspace name" fields, 12-char hint.
- Theme toggle (sun/moon icon) in the sidebar footer; user chip (initials avatar, name, email) in footer.
- Workspace name under the logo; collapse-sidebar button (no collapsed state drawn).
- Keyboard hints: `Cmd+K` on New chat, `Esc` on Stop generating.
- Table/grid view toggle in the library (only the table is drawn).
- Document count on the Documents nav entry; "N documents · M processing" subtitle.
- Detail: breadcrumb, Download and More buttons, find-in-text input and Copy text, page markers, image zoom caption,
  OCR confidence tag and low-confidence wavy underline, entity groups (People / Organizations / Topics), stat grid.
- Chat header: scope tag, "More" menu button, Sources toggle with count.
- "Open in document" link on each source card; "View N passages" button on model error.
- Skeleton loading cards in the sources panel during search.

## 2. Layout

Frame sizes: desktop 1440x900, tablet 1024x768. Everything is a flex row filling the viewport, no page scroll;
regions scroll internally.

### App shell (chat, library, detail)
- **Sidebar**: fixed 256px, `flex:none`, background `--dm-side` (surface mixed 45% into bg), right edge
  `1px` divider. Same width at 1440 and 1024 (no responsive change drawn).
  - Header (padding 14/14/10): logo tile 26px (radius 7, accent 1px inset ring, `book-open-text` icon 15px),
    "DocMind" 14px/500, workspace name 11.5px muted, collapse button 30px.
  - Block (padding 4/12/8, gap 4): **New chat** primary button, 36px high, left-aligned, `Cmd+K` hint right;
    **Documents** nav row 34px high, radius 8, icon 17px, count right. Active nav: bg accent-900, text accent-200.
  - Search input: 32px high, 13px, transparent bg, 30px left padding, match count ("3 found") right when filtering.
  - History: groups "Today", "Previous 7 days", "Older" (11px uppercase, 0.06em, muted, padding 14/8/4).
  - Footer: padding 10/14, top divider, avatar 28px circle (accent-800 bg, 11px/500 initials), name 13px, email 11.5px, theme button 30px.
- **Main**: `flex:1; min-width:0`. Chat header 56px high, padding `0 20px 0 40px`. Content padding `24px 40px 16px`.
  Reading measure is `max-width:72ch` for transcript, composer, empty chat, content tab.
- **Sources panel (right)**: desktop 340px, docked in the flow, bg `--dm-bg`, left edge 1px divider, 56px header.
  Sections padding `2px 14px 14px`, card gap 10.
  - Desktop: open by default in all chat states except `empty` and `search`. Toggled by header "Sources" button (aria-pressed;
    pressed style = accent text + accent border) or the close button.
  - **Tablet (1024)**: panel is an overlay, 360px wide, absolute right/top/bottom, z-index 2, bg surface, `--dm-shadow-lg`,
    over a scrim of `neutral-900 @ 55%`. Closed by default except during `streaming`. Click scrim to close.
  - Docked panel at 1024 would leave 1024-256-340 = 428px for chat; the mocks avoid this by overlaying.
- **Library**: header padding `28px 40px 0` (h1 26px, subtitle 13px muted, Upload button 36px). Dropzone row then toolbar
  (`padding:18px 40px 0`, gap 14), table padding `6px 40px 0`. Bulk-action bar appears under the toolbar.
- **Detail**: header padding `20px 40px 0`; body padding `24px 40px`. Summary uses two columns that wrap
  (`flex:1 1 480px; max-width:70ch` + `flex:1 1 260px; max-width:360px`, gap 40); Analysis `1 1 380px/max 520` +
  `1 1 320px/max 440`; image content `1 1 300px/max 560` + `1 1 280px/max 60ch`. Wrapping gives the 1024 layout.
- **Auth**: left column `flex:1 1 560px; max-width:640px`, padding `56px 88px`, form `max-width:400px`. Right marketing card
  (margin 16, radius 14, radial accent-900 glow on surface, padding 64) only when desktop; tablet shows the form alone.

Breakpoints: only two frames (1440, 1024). The mocks imply a single breakpoint where the panel changes from docked to overlay;
exact threshold is not specified (choose 1200px as an implementation decision). Nothing below 1024 is mocked.

## 3. Design tokens

Naming: the mocks use `--color-*` names. Below they are mapped to `--dm-*`. Light theme is derived in the mocks by
overriding the same variables (accent ramps invert; `-100` becomes darkest). The mocks only define dark in the token file;
light values come from the `LIGHT` object in the screens/component files.

### Fonts
- Family: **Inter** only, for headings and body (`--font-heading` and `--font-body` both `"Inter", system-ui, sans-serif`).
- Weights loaded: 400, 500, 600, 700 (normal style). Heading weight token = 500.
- The seven woff2 files are the Google Fonts per-subset slices of Inter, `font-display: swap`: cyrillic-ext, cyrillic, greek-ext,
  greek, vietnamese, latin-ext, latin, repeated per weight (4 weights x 7 subsets; the files are shared across weights, which
  indicates a variable font: 7 files). Sizes in KB: cyrillic-ext 26, cyrillic 19, greek-ext 11, greek 19, vietnamese 10,
  latin-ext 85, latin 48. Ship at least latin + latin-ext.
- No monospace face is defined or used. Phosphor icons are loaded from unpkg (`@phosphor-icons/web@2.1.1`, class `ph ph-*`);
  the app should bundle icons rather than load from a CDN.

### Type scale (px, as used)
| Use | Size / line-height | Weight |
|---|---|---|
| Auth h1 | 30 | 500 |
| Empty-chat h2 | 28 | 500 |
| Library/empty h1/h2 | 26 | 500 |
| Detail h1 | 24 | 500 |
| Detail h3 (content heading) | 19 | 500 |
| Dialog title | 20 | 500 |
| Body default | 14 / 1.5 (token file: 15 / 1.55) | 400 |
| Answer text | 15.5 / 1.7 | 400 |
| User bubble | 15 / 1.6 | 400 |
| Composer input | 15 / 1.55 | 400 |
| Document content text | 15.5 / 1.75 | 400 |
| Summary TL;DR | 17 / 1.65 | 400 |
| Chat title (header) | 15 | 500 |
| Session title | 13.5 | 400 |
| Session time, captions | 11.5 | 400 |
| Group label, eyebrow | 11-12, uppercase, 0.06-0.08em | 400 |
| Headings letter-spacing | -0.015em, line-height 1.12 | |

### Spacing, radii, shadows
- Spacing tokens (base 2.8px, scaled): 2.8, 5.6, 8.4, 11.2, 16.8, 22.4. Mock layouts mostly use literal 4/6/8/10/12/14/16/18/24/40.
- Radii: sm 4, md 8 (buttons, inputs, cards, badges use 6), lg 14 (bubble, composer, dropzone, dialog).
  Small chips and file icons 5-7; avatar 50%; stop button pill 999.
- Shadows are hairline rings, not blurs (dark): sm `0 0 0 1px neutral-800`, md ring + `0 6px 18px rgba(0,0,0,.55)`,
  lg ring + `0 16px 40px rgba(0,0,0,.65)`.

### Ready-to-paste CSS

```css
:root {
  /* Dark is the base (matches the mocks' token file). */
  --dm-bg: #161826;
  --dm-surface: #232532;
  --dm-side: color-mix(in srgb, var(--dm-surface) 45%, var(--dm-bg));
  --dm-text: #e9e9ed;
  --dm-muted: color-mix(in srgb, var(--dm-text) 62%, transparent);
  --dm-divider: color-mix(in srgb, #e9e9ed 16%, transparent);

  --dm-accent: #9184d9;
  --dm-accent-2: #a7a1db;
  --dm-accent-100: #f5f4ff; --dm-accent-200: #e7e5fe; --dm-accent-300: #d2cefd;
  --dm-accent-400: #b5abfc; --dm-accent-500: #968ae0; --dm-accent-600: #796cbf;
  --dm-accent-700: #5d5294; --dm-accent-800: #423a6a; --dm-accent-900: #2b2741;

  --dm-neutral-100: #f3f5fe; --dm-neutral-200: #e4e7f5; --dm-neutral-300: #cfd3e5;
  --dm-neutral-400: #b2b6ca; --dm-neutral-500: #9397ab; --dm-neutral-600: #75798c;
  --dm-neutral-700: #595d6c; --dm-neutral-800: #3f424d; --dm-neutral-900: #292b31;

  /* Status */
  --dm-ok: oklch(0.8 0.12 158);   --dm-ok-bg: oklch(0.31 0.05 158);
  --dm-err: oklch(0.76 0.13 22);  --dm-err-bg: oklch(0.31 0.06 22);
  --dm-busy: var(--dm-accent-200); --dm-busy-bg: var(--dm-accent-900); /* uploading / parsing / indexing */

  /* File-type icon tiles: bg / fg per hue (dark). Hue: PDF 25, DOC/DOCX 255, MD 200, ORG 140, PNG/JPG 70, TXT neutral (chroma 0). */
  --dm-ftype-bg: oklch(0.34 0.06 var(--h, 0));
  --dm-ftype-fg: oklch(0.87 0.08 var(--h, 0));

  --dm-font: "Inter", system-ui, sans-serif;
  --dm-font-heading-weight: 500;

  --dm-space-1: 2.8px; --dm-space-2: 5.6px; --dm-space-3: 8.4px;
  --dm-space-4: 11.2px; --dm-space-6: 16.8px; --dm-space-8: 22.4px;

  --dm-radius-sm: 4px; --dm-radius-md: 8px; --dm-radius-lg: 14px;

  --dm-shadow-sm: 0 0 0 1px #3f424d;
  --dm-shadow-md: 0 0 0 1px #595d6c, 0 6px 18px rgba(0,0,0,.55);
  --dm-shadow-lg: 0 0 0 1px #9397ab, 0 16px 40px rgba(0,0,0,.65);

  --dm-focus-ring: 2px solid var(--dm-accent); /* offset 2px */

  --dm-sidebar-w: 256px;
  --dm-panel-w: 340px;          /* desktop docked */
  --dm-panel-w-overlay: 360px;  /* tablet overlay */
  --dm-measure: 72ch;
}

/* Light theme: apply via [data-theme="light"], and mirror under prefers-color-scheme if the app follows the OS. */
:root[data-theme="light"] {
  --dm-bg: #f3f5fe;
  --dm-surface: #e4e7f5;
  --dm-side: #eceff9;
  --dm-text: #161826;
  --dm-divider: color-mix(in srgb, #161826 16%, transparent);

  --dm-accent: #5d5294;
  --dm-accent-100: #2b2741; --dm-accent-200: #423a6a; --dm-accent-300: #5d5294;
  --dm-accent-400: #796cbf; --dm-accent-500: #968ae0; --dm-accent-600: #b5abfc;
  --dm-accent-700: #d2cefd; --dm-accent-800: #e1defd; --dm-accent-900: #ecebfd;

  --dm-neutral-100: #292b31; --dm-neutral-200: #3f424d; --dm-neutral-300: #595d6c;
  --dm-neutral-400: #75798c; --dm-neutral-500: #9397ab; --dm-neutral-600: #b2b6ca;
  --dm-neutral-700: #cfd3e5; --dm-neutral-800: #dde0ef; --dm-neutral-900: #e9ecf8;

  --dm-ok: oklch(0.46 0.11 158);  --dm-ok-bg: oklch(0.92 0.045 158);
  --dm-err: oklch(0.5 0.16 25);   --dm-err-bg: oklch(0.93 0.035 25);

  --dm-ftype-bg: oklch(0.9 0.04 var(--h, 0));
  --dm-ftype-fg: oklch(0.42 0.1 var(--h, 0));   /* TXT: chroma 0 in both themes */

  --dm-shadow-sm: 0 0 0 1px #cfd3e5;
  --dm-shadow-md: 0 0 0 1px #cfd3e5, 0 6px 18px rgba(22,24,38,.10);
  --dm-shadow-lg: 0 0 0 1px #b2b6ca, 0 16px 40px rgba(22,24,38,.16);
}
```

Notes on the tokens:
- Light `--dm-accent` (#5d5294) is accent-700 of the dark ramp; dark `--dm-accent` (#9184d9) is a separate value (not on the ramp).
- Text on accent fills (selected citation marker, number badges) is `--dm-bg`.
- Ready/failed text colors were not contrast-checked in the mocks; verify AA for `--dm-ok` on `--dm-ok-bg`, `--dm-muted`
  (62% text) on `--dm-surface`/`--dm-side`, and `--dm-accent-300` links in both themes (spec requires AA).
- Dark-theme mocks use `--dm-accent-300` (#d2cefd) for links, eyebrows and "Open in document"; in light it resolves to #5d5294.
- Dialog backdrop: `neutral-900 @ 50%`; tag classes: accent (bg accent-800/text accent-100), neutral (neutral-800/neutral-100), outline (1px accent).

## 4. Component inventory

### Buttons
Base: inline-flex, gap 6, 14px/500 Inter, padding `5.6px 10px`, radius 8, 1px border, default height ~32 (36 for primary CTAs, 40 on auth).
Variants: **primary** = transparent fill, accent text and accent 1px border (outlined, not solid); hover accent 12% fill, active 22%.
**secondary** = divider border; hover text 7%, active 14%. **ghost** = accent text, no border, hover 10%/active 18%.
**icon** 36x36 (26-32 in toolbars, borderless muted). Disabled opacity .45. Focus: 2px accent outline, offset 2px.

### Inputs
`.input`: min-height 36, padding `6px 10px`, 14px, surface bg, 1px divider border, radius 8, accent caret. Hover border text 45%; focus border accent.
Label 12px, text 70%. Error: border `--dm-err` + 12px error line with `warning-circle` icon. Search inputs: 32-34px high, 13px, 30px left padding for icon.
Textarea min-height 90.

### Session list item
Row: flex, align center, gap 6, padding `6px 6px 6px 10px`, radius 8, cursor pointer. Two lines: title 13.5px (single line, ellipsis), time 11.5px muted.
States: idle (transparent); hover (text 6% fill; shows pencil and trash icon buttons, 26px, borderless muted); active (bg accent-900 + inset 1px accent-800);
search match (`<mark>` bg accent-800, text accent-100, radius 3, padding 0 1px). Active row's second line in the component sheet reads "Active · 12 min ago" (sheet label; real UI shows relative time only).
Group headers: Today / Previous 7 days / Older. Times: "12 min ago", "2 h ago", "Yesterday", "2 days ago", then "Sep 28" style for Older.

### Chat bubbles
- **User**: right-aligned, surface bg, padding `11px 16px`, radius `14 14 4 14`, 15px/1.6, `max-width:56ch` (90% in sheet).
- **Assistant**: no bubble; unboxed text at 72ch. Header row: 20px logo tile (radius 6, accent ring, `book-open-text`) + "DocMind" 12.5px muted.
  Paragraph gap 14, 15.5px/1.7, `text-wrap:pretty`. Block gap between turns 22.
- **Streaming caret**: 8x17 accent block, radius 2, blinks 1s steps (`dmBlink`) at end of last paragraph.
- **Action row** (after complete answer): ghost buttons Copy, Regenerate, "4 sources", muted 13px, margin-left -6.
- **Stop generating**: pill button above composer (32px high, radius 999, shadow-sm, "Esc" hint); also swaps the Send button for a Stop icon button.
- **Error: no sources**: `file-dashed` icon 20px accent, 16px/500 "I couldn't find this in your documents.", muted paragraph naming the search terms, buttons Upload a document (primary) and Rephrase question (secondary). Max 62ch. Sources panel shows "No supporting passages" empty state.
- **Error: model unavailable**: err-bg card, `cloud-x` icon, err-colored title "The answer model is unavailable", body, buttons Retry (primary) and "View 2 passages". Sources panel title becomes "Passages found / not yet answered".

### Citation marker
Inline button after the cited clause: min-width 18, height 18, padding `0 4px`, margin `0 1px 0 3px`, radius 5, 11px, vertical-align 2px, aria-label "Source N".
Idle: bg accent-800, text accent-100. Selected: bg accent, text bg. Activates on click or mouseenter, which also selects the matching source card (state is shared). No separate hover style drawn beyond selection.
A segment with citation index 0 means uncited text.

### Source card (sources panel)
Article, radius 8, padding `12px 14px`, gap 6, transition .15s. Row 1: number badge (same as marker) + file-type tile 20px + document title 13px/500 (ellipsis).
Row 2: location 12px muted ("Page 12 · 3.2 Major incidents", "§18.1 ...", "Root cause"). Row 3: quote 13px/1.6 in curly quotes with ellipses, matched span in `<mark>` (accent-800/accent-100, radius 3). Row 4: "Open in document" link (12.5px, accent-300, arrow icon).
Idle: transparent + shadow-sm. Selected: bg accent-900 + `0 0 0 1px accent`. Loading: skeleton card (3 pulse bars 60/92/78% wide, 10/8/8px high, neutral-800, `dmPulse` 1.4s).
Panel header: title ("Sources"), sub ("searching…", "2 cited so far", "4 cited"), close button.

### Tool-activity step list: see section 5.

### Composer
Container: surface bg, radius 14, shadow-sm, padding `12px 10px 10px 16px`, gap 8. Textarea 2 rows, 15px, no border, no resize, aria-label "Message".
Toolbar row: attach button (32px, paperclip; tooltip "Attach - uploads to your library and adds it to this chat"), scope button (28px high, 12.5px muted: stack icon + label + caret), spacer, Send (primary icon, 32px, `arrow-up`) or Stop (secondary icon, `stop`).
Placeholder: "Ask about the selected documents..." (empty chat), "Ask a follow-up..." otherwise. Hint below: "Answers cite your documents - Shift + Enter for a new line" 11.5px muted. Padding outside `0 40px 18px`, width capped at 72ch.

### Scope picker
Empty chat: label "Scope" 12px, segmented control (`.seg`: radius 8, option padding `7px 12px`, 13px, selected = accent text + inset 1px accent) with "All documents" / "Specific documents". For specific: chips (30px high, radius 8, surface bg, shadow-sm, 13px; 20px file tile, title, 22px remove button) and a dashed "Add document" button.
In header: neutral tag with `stack` icon + label ("All documents", "2 documents", "1 document"). In composer: scope button with caret. **The picker popover/list is not drawn.**

### Upload dropzone
Library: row with icon 24px accent + title 14px + hint 12px muted ("PDF, DOCX, DOC, TXT, Markdown, Org, PNG, JPG - up to 50 MB each"); padding `14px 18px`, radius 14, `1.5px dashed neutral-700`.
Drag-over: dashed accent border, accent 10% fill, icon `arrow-fat-line-down`, text "Release to upload 2 files". Empty-library variant: full-width card (max-height 520, padding `56px 64px`, radial accent-900 glow, 40px `files` icon, h2 26px "Upload your first documents", 52ch muted text, Browse files button 38px, type chips for 8 types, "Up to 50 MB per file"). Per-file progress is a 3px bar in the table row (see below), not in the dropzone.

### Status badge
Height 22, padding `0 8px`, radius 6, 12px, icon + label, gap 5.
| State | Label | Icon | Colors |
|---|---|---|---|
| Uploading | "Uploading 64%" | `arrow-up` | accent-900 / accent-200 |
| Parsing | "Parsing" | `circle-notch`, spins 1.2s | same |
| Indexing | "Indexing" | `circle-notch`, spins | same |
| Ready | "Ready" | `check-circle` | ok-bg / ok |
| Failed | "Failed" | `warning-circle` | err-bg / err, plus ghost "Retry" button |
Uploading also shows a 3px bar (110px wide in table, 160 in sheet; track neutral-800, fill accent) under the badge. Failed rows show a 12px err-colored reason under the title (e.g. "Couldn't open - the file is password-protected").

### File-type icon
Rounded tile with the extension as label (label carries meaning, hue only aids scanning). Sizes: 20px/radius 5/8px text (chips, cards), 28/6/9 (table), 32/7/9.5 (sheet), 44/10/11 (detail header), 22-high chip with 10.5px text (type chips).
Labels: PDF, DOCX, DOC, TXT, MD, ORG, PNG, JPG (source cards and scope chips show "DOC" for DOCX and "IMG" for PNG/JPG; the table shows the real extension). Hues in the CSS block above.

### Document table
Columns: checkbox (34), Name (flex), Type (64), Size (76), Uploaded (96), Status (168), actions (36). Header 11px uppercase 0.08em, 60% text.
Cell padding 5.6px. Row dividers are fading 1px gradient strips (transparent -> text 8% over 48px at each end). Row hover: text 4% tint. Selected row: accent 9% fill; checkboxes use `accent-color: accent`.
Cell text 13px muted for type/size/date. Toolbar above: search (flex `0 1 280px`, 34px), Type filter button, Status filter button (active filter = accent text and border), spacer, table/grid segmented toggle (grid not drawn).
Bulk bar on selection: surface bg, shadow-md, radius 8: "3 selected", Chat with selected (primary, 32px), Delete (secondary), Clear (ghost).

### Document detail tabs
Header: breadcrumb (12.5px muted, caret separators), file tile 44px, h1 24px, meta row 13px muted (type, size, pages, words) + Ready badge, buttons Download (icon), More (icon), **Ask about this document** (primary 36px, `chat-circle-text`).
Tab list: gap 22, bottom 1px divider, tab padding `8px 0 10px`, 14px; active = text color + inset 2px accent underline; inactive muted. `role=tablist/tab`, `aria-selected`.
- **Summary**: TL;DR (eyebrow 12px uppercase accent-300; text 17px), Key points (ordered list, 15px, page refs "p. 3" 12px muted), Entities & topics (neutral tags grouped by People / Organizations / Topics), Suggested questions (secondary buttons, `chat-circle-text` icon accent).
- **Analysis**: Structure outline (numbered rows, indent 24 for level 2, 14.5/13.5px, page right), 3-column stat grid (label 12px muted, value 19px/500: reading time, language, words, pages, tables, figures), Notable dates and Notable numbers (76px accent-300 key column, tabular numerals).
- **Content (text)**: find-in-text input + Copy text; 72ch; page markers "Page 12 of 38" (11.5px uppercase muted); h3 19px; paragraphs 15.5px/1.75.
- **Content (image)**: left image frame (aspect 4:3, radius 8, shadow-sm, striped placeholder, caption "Click to zoom - highlighted regions match the text"), right "Extracted text" with accent tag "OCR - 92% confidence", text block (surface bg, 15px/1.8, radius 8, padding `14px 16px`), low-confidence words wavy-underlined in accent with legend.

### Dialogs
**Not mocked.** Token file defines: backdrop fixed, grid-centered, `neutral-900 @ 50%`; dialog `min(440px,100%)`, padding 11.2px (very tight; likely raise to ~20-24), radius 14, surface bg, shadow-lg, title 20px/500, body 14px at 85% opacity, actions right-aligned gap 5.6. Needed but undrawn: delete session, delete documents, delete account (spec/brief require explicit irreversibility text).

### Toasts
Role `status` (or `alert` for errors). Padding `10px 10px 10px 14px`, radius 8, surface bg, shadow-md, 13.5px, gap 10. Leading icon 18px (`check-circle` ok / `warning-circle` err), message, ghost action ("View" / "Retry"), optional 26px dismiss. Placement in the library frame: absolute, bottom 24, right 24 of the main region. No auto-dismiss timing or stacking specified.

### Empty states
Icon 24-26px muted (or 40 accent for library), 500-weight title, 13px muted cause line, at most one action. Card variant: radius 14, shadow-sm, padding 20. Present for: no chats, no documents, no passages, empty chat (prompt list).
Suggested-prompt rows: secondary buttons, padding `10px 14px`, icon 18px accent, title 14px + sub 12.5px muted, trailing `arrow-up-right`. Prompts: "Summarize my latest upload", "Compare the Q3 report and the July 12 postmortem", "What do my docs say about error budgets?".

## 5. Chat thinking and tool activity

**The mocks show tool activity but NOT model thinking/reasoning.** The words thinking and reasoning do not appear anywhere. There is no
collapsible thought block, no reasoning stream, no "Thinking..." label.

What is drawn is a **tool-step list** inside the assistant turn, between the "DocMind" header and the answer text:
- Container: `role="status"`, padding `10px 12px`, radius 8, shadow-sm hairline ring, `max-width:60ch`, rows gap 6.
- Row: 13px; 16px icon slot, bold-ish label (not truncated), muted detail (single line, ellipsis).
  Icon states: done = `check` ok-color; active = `circle-notch` accent, spinning `.9s linear` (`dmSpin`); fail = `x-circle` err; none = `minus-circle` muted.
- Per state:
  - `searching`: [done] "Searched 48 documents" - `"july 12 outage", "root cause", "postmortem"`; [active] "Reading passages..." - document names. Sources panel shows 3 skeleton cards, sub "searching...". No answer text yet.
  - `streaming`: [done] Searched 48 documents; [done] "Read 4 passages from 2 documents"; answer streams with blinking caret; panel shows 2 cited so far + 1 skeleton; Stop generating visible.
  - `answered`: same two done rows, list stays above the answer (not collapsed).
  - `no-sources`: [done] "Searched 48 documents"; [none] "No relevant passages found".
  - `model-error`: [done] Searched 1 document; [done] Read 2 passages; [fail] "Answer generation failed" - "model unavailable".
- The component sheet shows a single compact variant ("Searched 48 documents" + "tool step" tag).
- Steps are per answer, one list; multiple tool calls per turn are modeled as multiple rows. Arguments appear only as quoted search terms.
  There is no expanded/collapsed state, no per-step duration, no tool-name display, no result preview.

**Decision (spec §6.5): the step list becomes `dm-thinking`.** Its first row is "Thinking": a spinner while
summarized thinking streams and a check when done. It expands to muted 13px thinking text, opens by default while
thinking streams, and collapses automatically when the answer starts. Users can expand it again, including in past
chats. Tool-step rows follow in order, unchanged from the mocks. The container keeps the mock styling and gets
`aria-live="polite"`.

## 6. Deviations and conflicts

Versus brief:
1. Account settings, Delete-my-account confirmation and generic confirmation dialog are missing (brief items 6 and component list).
2. Scope selector has no document-picker popover; brief asks for "pick specific documents (chips)": chips exist, the picking UI does not.
3. Grid view toggle appears but no grid is drawn. Rename/delete flows and row/filter menus are not drawn.
4. "Uploading %" progress is a bar in the table row; brief's "dropzone with progress" has no in-dropzone progress state.
5. Pages/words in detail header: present (pages or "1 image", words). Entities/topics, suggested questions, structure, reading time, language, dates, numbers: all present.
6. Regenerate and Copy are shown only after a completed answer; no copy button on user messages.
7. Brief asks for 1440 and 1024 frames per state: provided via device prop. No sub-1024 layout.

Versus spec §7:
1. The mocks' "Sources" panel is one panel with the selected citation; spec's `dm-citation` / `dm-source-panel` split matches (marker + card share selected index). Linking is by index; the cited passage text is highlighted via `<mark>` on a span, which implies the API must return the quoted span offsets (or the front end finds them).
2. Citation markers are inline buttons inside paragraphs; whether `lu-chat` can render these is the PR 35 spike. The mock's per-paragraph segment model (text, citation index) needs a custom renderer if the spike fails.
3. Tool-step list and the "thinking" requirement (section 5): the spec lists no tool-activity/reasoning component; resolved: `dm-thinking` (section 5, spec §6.5).
4. `aria-live="polite"` is not in the mocks (the step list uses `role="status"`, which is implicitly polite). Streaming answer region needs it added.
5. Dark is the mocks' design baseline; light is derived by variable override. Spec requires AA in both: contrast of muted text (62%), `--dm-ok`/`--dm-err` on their tints and accent-300 links is unverified.
6. Doc table: spec uses `lu-data-table`; the mocks use fading row dividers, a 7-column layout and inline status/progress that likely exceed that component's styling, so `dm-doc-table` will need custom cell renderers or its own markup.
7. Primary buttons are outlined, not solid; the focus ring is 2px accent offset 2px. Follow the mocks, not typical defaults.
8. Phosphor icons come from a CDN in the mocks; the app should self-host (spec's security posture) and the stack is Lit, not React.
9. The mocks' "Selected" library frame shows a toast "2 files added to the upload queue" next to a drag-over dropzone and a bulk-select bar at once; treat it as a composite demo, not a real state.

Mock inconsistencies to not copy: file-tile label (DOC vs DOCX, IMG vs PNG/JPG) differs between chat and table; `--muted` is a derived token that must be defined in the app (included above); sheet label "Active . 12 min ago" and "Hover . 2 h ago" are annotations.

Deviations applied in `apps/web/src/styles/tokens.css` (Task 178a), each covered by `contrast.test.ts` / `lu.test.ts`:
1. Light `--dm-muted` is `color-mix(in srgb, var(--dm-text) 70%, transparent)`, not the dark 62%: 62% gives about 4.4:1 on `--dm-surface` in light; 70% gives about 5.9:1.
2. Added `--dm-warn` (dark `oklch(0.8 0.13 80)`, light `oklch(0.5 0.12 70)`) for loom-ui's warning status.
3. Added `--dm-tag-accent-bg`, `--dm-tag-accent-fg` and `--dm-scrim` (the mocks used these values inline).
4. Added `color-scheme: dark` on `:root` and `color-scheme: light` on the light block.
5. Added the `--lu-*` bridge in its own `:root` rule after the theme blocks, so loom-ui elements follow either theme.
6. No colour pair needed a nudge: every pair in both themes passed at the values above.
