# Design brief: DocMind — a document assistant (desktop web app, responsive to tablet)

## Product
DocMind lets a signed-in user upload documents, get automatic summaries and analysis,
and ask questions about their documents in a chat. Every answer cites the passages it
used. Users can return to any past chat.

## Users
Knowledge workers with 10–500 documents (specs, notes, reports, scans). Signed-in,
multi-user product; each user sees only their own workspace.

## Screens to mock (each with the states listed)

1. **Sign in / Sign up** — email + password; error state; "create workspace" on sign-up.

2. **App shell** — three regions:
   - Left sidebar: "New chat" button; list of past chat sessions grouped by
     Today / Previous 7 days / Older, each showing an auto-generated title and a relative
     time; hover actions: rename, delete. Search box filtering sessions by title.
     A "Documents" nav entry above the session list.
   - Main: active chat.
   - Right panel (collapsible): sources for the current answer.

3. **Chat** —
   - Empty state for a new chat: suggested prompts ("Summarize my latest upload",
     "Compare X and Y", "What do my docs say about …"), plus a scope selector:
     "All documents" or pick specific documents (chips).
   - Conversation: user messages; assistant answers streaming token by token; inline
     citation markers [1][2] that highlight the matching source card in the right panel;
     a visible "searching documents…" / tool-activity step while the agent works;
     stop-generating button; regenerate; copy.
   - Error states: model unavailable; answer has no supporting sources ("I couldn't find
     this in your documents").
   - Composer: multiline input, attach-document button (uploads into the library and adds
     it to this chat's scope), send.

4. **Document library** —
   - Drag-and-drop upload zone accepting: PDF, DOCX, DOC, TXT, Markdown, Org, PNG/JPG.
     Show the accepted types and the max size (50 MB).
   - Table/grid of documents: icon by type, title, size, uploaded date, status badge
     (Uploading % → Parsing → Indexing → Ready, or Failed with a retry action).
   - Filters: type, status; search by title. Multi-select → "Chat with selected", delete.
   - Empty state for a brand-new workspace.

5. **Document detail** —
   - Header: title, type, size, pages/words, status.
   - Tabs: Summary (TL;DR, key points, entities/topics, suggested questions);
     Analysis (structure outline, reading time, language, notable dates/numbers);
     Content (extracted text preview; for images, the image next to its extracted text).
   - "Ask about this document" button → opens a new chat scoped to it.

6. **Account settings** — profile, sign out, and "Delete my account" with a confirmation
   step explaining that deletion is permanent and irreversible.

## Visual direction
Calm, content-first, high legibility for long text. Neutral palette with one accent
color; status colors for ready / processing / failed. Light and dark themes. Comfortable
reading width for answers (~70ch). Clear focus states, keyboard-navigable, WCAG AA contrast.

## Components to define as a mini design system
Buttons, inputs, chips, status badges, file-type icons, session list item, chat bubble
(user / assistant), citation marker + source card, upload dropzone with progress, tabs,
empty states, toasts, confirmation dialog.

## Deliverables
One frame per screen and state above, at 1440px desktop and 1024px tablet, plus the
component sheet.
