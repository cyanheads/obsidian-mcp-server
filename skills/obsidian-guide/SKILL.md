---
name: obsidian-guide
description: "Gates and multi-call workflows for the obsidian_* tools: pin active and periodic targets to a path, round-trip heading sections without editing the wrong one or dropping its sub-sections, page a search to the end before editing its hits, match tags exactly, and repeat writes after a timeout or a dropped connection. Use before editing several notes, restructuring headings, writing to a periodic note, retagging, moving a note, or retrying a failed obsidian_* write."
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

One Obsidian vault, reached through the Local REST API plugin while Obsidian runs. Each note tool reads or edits one note per call. No tool moves or renames a note, and none rewrites links in other notes. The multi-note jobs are the workflows below.

## Identifiers

- **Note path**: `hits[].filename` from obsidian_search_notes, `entries[].path` from obsidian_list_notes, and the `path` every note tool returns. Writes and deletes match it exactly, letter case included.
- **Heading locator**: the full `Parent::Child` paths in obsidian_get_note's `document-map` `headings`, and the `sectionTarget` a section read or write returns.
- **Tag**: no leading `#`. A note's own `tags` (obsidian_get_note `full`, the JSONLogic `tags` field) hold its tags as written, letter case included. Parent tags show up only in tag counts.

## Gates

1. **Pin `active` and `periodic` targets after the first call.** Each call resolves them again. `active` is whichever file has focus in Obsidian at that moment, and a `periodic` target with no `date` is the current period. For the rest of the task, address the note by the `path` the first call returned.
2. **A missing periodic note can't be created through a `periodic` target.** Every tool reads the target before acting, so a write to a period with no note also fails `periodic_not_found`. Ask the user to create it in Obsidian. Or, if they agree, write it by path: read an earlier period's note (pass `date`) to learn the folder and filename pattern. A note written this way holds only what you send, without the user's periodic-note template. On Local REST API 5.0.2 and later without the periodic-notes extension, every `periodic` target fails `periodic_unsupported`, whether or not the note exists; find the note with obsidian_search_notes or obsidian_list_notes and address it by path.
3. **Write a heading back with the `sectionTarget` the read returned, never the bare name you sent.** A bare name resolves differently on each side. A read takes the first heading with that text in document order. A write takes the top-level heading with that text when there is one. Reading `Notes` and then writing `Notes` can touch two different sections.
4. **A heading section is its whole subtree.** obsidian_get_note `format: "section"` returns the heading line, its body, and every sub-section under it. A replace rewrites all of that, so send the sub-sections back or target the child heading instead. An append lands below the last sub-section. A prepend lands right under the heading line. Round-trip a read through obsidian_write_note with `section`, which drops the leading heading line. obsidian_patch_note `replace` keeps a leading `#` heading line, and plugin v5.0 and later refuse that with `heading_outside_section`.
5. **Page a search to the end before editing its hits.** Without OBSIDIAN_READ_PATHS or OBSIDIAN_DENY_PATHS, every page re-runs the search. The cursor is an offset into the new result, so edits that remove matches shift later pages and skip notes. Under a read scope, later pages come from the first page's hits for at most 5 minutes past the last page read. Collect every `filename` first, then edit.
6. **A text hit doesn't promise a replace match.** Text mode needs each token somewhere in the filename or body, in any case. obsidian_replace_in_note needs the exact string, case-sensitive by default, and searches the body only by default. Read each note's `perReplacement[].count`: `0` is a success that wrote nothing. `useRegex` patterns run without the `m` flag, so `^` and `$` match the ends of the scoped text, not of a line. To anchor a line, use `(?<=^|\n)` and `(?=\n|$)`.
7. **Tags match exactly.** `{"in": ["work", {"var": "tags"}]}` misses notes tagged only `Work`, or only `work/tasks`, which obsidian_list_tags still counts under `work`. To catch nested tags, use `{"some": [{"var": "tags"}, {"regexp": ["^work(/|$)", {"var": ""}]}]}`. obsidian_manage_tags `remove` is exact the same way, and its default `location: "frontmatter"` leaves inline `#tag`s in the body. Pass `location: "both"` and check the returned `tags`.
8. **A JSONLogic hit is a note whose tree returns something truthy**, and that value is the hit's `result`. A note whose tree returns `false`, `null`, `0`, `""`, `[]`, or `{}` is left out. Return the field you need and one search reads it from every match: `{"if": [<test>, {"var": "tags"}, null]}` gives each match's tags. An empty value still drops the note.
9. **After `obsidian_timeout` or `obsidian_unreachable` on a write, assume it may have landed.** One write call makes several requests under one shared budget (45 s at the default timeout): a read before the write, the write, and a read after. The error can arrive after the write applied, and the server never re-sends a whole-file append or a section write. Repeating is safe for obsidian_write_note, obsidian_patch_note `replace`, obsidian_manage_frontmatter, and obsidian_manage_tags. On a retry, `file_exists` (a create), `note_missing` (a delete), and `content_preexists` (a section append or prepend sent without `applyIfContentPreexists`) each mean the first attempt landed. Don't force a `content_preexists` through with `applyIfContentPreexists`. Read the note before repeating a whole-file obsidian_append_to_note, or an obsidian_replace_in_note whose `replace` still contains its `search`.
10. **Confirm before deleting.** obsidian_delete_note deletes on the first call unless its description says it asks. Get the user's go-ahead on the exact path first.

## Workflows

**Capture into a periodic note.** Call obsidian_append_to_note with the `periodic` target. Add `section` to land under one of the note's headings, and `createTargetIfMissing: true` if that heading may not exist yet. On `periodic_not_found` or `periodic_unsupported`, follow gate 2. Follow-up edits use the returned `path` (gate 1).

**Restructure headings.**

1. Call obsidian_get_note `document-map` for every full heading path.
2. Read each section you'll change by its full path, edit it, and write it back through obsidian_write_note `section` (gates 3–4).
3. Rename or remove a heading line with obsidian_replace_in_note. No section write changes a heading line.
4. To reorder or move whole sections, rewrite the note: obsidian_get_note `content`, edit, then obsidian_write_note `overwrite: true`. Compare `previousSizeInBytes` with `currentSizeInBytes`.
5. A renamed heading breaks `[[Note#Old heading]]` links in other notes. Fix them as in *Move or rename a note*.

**Find, then edit across notes.**

1. Search and page to the end (gate 5). To find notes by filename anywhere in the vault, test `path` with `regexp` in jsonlogic mode, e.g. `{"regexp": ["(^|/)Meeting[^/]*\\.md$", {"var": "path"}]}`. Don't walk obsidian_list_notes for this: its `nameRegex` never enters a folder whose own name fails the pattern.
2. When `instructions` gives a narrower Writable scope than Readable, drop hits outside the Writable scope before writing.
3. Edit each hit and read its counts (gate 6).

**Retag notes.**

1. Find the notes with a tree that returns their tags (gates 7–8).
2. For each note, call obsidian_manage_tags `add` with the new tag and `remove` with the old one, both with `location: "both"`.
3. Confirm with obsidian_list_tags `nameRegex`. A parent tag's count includes its nested tags.

**Move or rename a note.** No tool does this, and nothing updates links that point at the old name.

1. Read the note with obsidian_get_note `content` and write it with obsidian_write_note at the new path. That write fails with `file_exists` rather than overwrite a note already there.
2. Find the notes that wikilink the old name with the backlink `regexp` in obsidian_search_notes' `logic` description. Rewrite each link with obsidian_replace_in_note (gate 6).
3. Delete the old note once the user agrees (gate 10).
