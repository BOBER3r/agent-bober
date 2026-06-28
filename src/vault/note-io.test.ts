import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNote, writeNote, listNotes } from "./note-io.js";

// ── sc-1-5: filesystem read / write / list ────────────────────────────

describe("note-io (file-backed, temp dir) (sc-1-5)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-vault-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writeNote -> readNote round-trips frontmatter and body", async () => {
    const note = {
      frontmatter: { status: "active", n: 5.4 },
      body: "# Hi\n\nbody\n",
      path: join(tmpDir, "a/b/note.md"),
    };
    await writeNote(note);
    const back = await readNote(note.path);
    expect(back.frontmatter).toEqual(note.frontmatter);
    expect(back.body).toBe(note.body);
    expect(back.path).toBe(note.path);
  });

  it("writeNote creates parent directories (ensureDir)", async () => {
    // Path nests two levels deep — neither 'a' nor 'a/b' exist yet.
    const note = {
      frontmatter: { title: "Deep note" },
      body: "content\n",
      path: join(tmpDir, "a/b/c/deep.md"),
    };
    await expect(writeNote(note)).resolves.toBeUndefined();
    const back = await readNote(note.path);
    expect(back.frontmatter.title).toBe("Deep note");
  });

  it("listNotes returns every .md file recursively under the vault dir", async () => {
    const notes = [
      { frontmatter: { title: "Note 1" }, body: "body1\n", path: join(tmpDir, "note1.md") },
      { frontmatter: { title: "Note 2" }, body: "body2\n", path: join(tmpDir, "sub/note2.md") },
      { frontmatter: { title: "Note 3" }, body: "body3\n", path: join(tmpDir, "sub/deep/note3.md") },
    ];
    await Promise.all(notes.map((n) => writeNote(n)));

    const all = await listNotes(tmpDir);
    expect(all.some((p) => p.endsWith("note1.md"))).toBe(true);
    expect(all.some((p) => p.endsWith("note2.md"))).toBe(true);
    expect(all.some((p) => p.endsWith("note3.md"))).toBe(true);
    expect(all).toHaveLength(3);
  });

  it("listNotes returns absolute paths", async () => {
    const note = {
      frontmatter: {},
      body: "",
      path: join(tmpDir, "abs.md"),
    };
    await writeNote(note);
    const all = await listNotes(tmpDir);
    expect(all.every((p) => p.startsWith("/"))).toBe(true);
  });

  it("readNote -> writeNote -> readNote full round-trip with all Dataview types", async () => {
    const original = {
      frontmatter: {
        title: "Round Trip",
        weight: 3.14,
        created: "2026-06-28T00:00:00.000Z",
        tags: ["x", "y"],
        status: "superseded",
      },
      body: "\n# Round Trip\n\nSome text.\n",
      path: join(tmpDir, "round-trip.md"),
    };
    await writeNote(original);
    const back = await readNote(original.path);
    expect(back.frontmatter).toEqual(original.frontmatter);
    expect(back.body).toBe(original.body);
  });
});
