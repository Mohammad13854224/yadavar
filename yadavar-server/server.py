"""
Yadavar server: a thin JSON layer over the *unmodified* official `anki` package (the same rslib backend that
the desktop app runs). All scheduling (queues, intervals, ease, learning steps, undo) is done by Anki itself;
this file only maps Yadavar's concepts onto Anki's:

  folder                ->  deck ("Parent::Child" names)
  card                  ->  note of the "Ankio" notetype (1 note = 1 card), in its folder's deck; cards at the
                            top level (outside every folder) live in Anki's "Default" deck (id 1)
  media                 ->  Anki's media folder

Run:  .venv\\Scripts\\python server.py   (serves the API on :8765 and the built UI from ../yadavar-app/dist)
"""

from __future__ import annotations

import json
import mimetypes
import traceback
import os
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

from anki.collection import AddNoteRequest, Collection
from anki.errors import InvalidInput
import math

from anki.deck_config_pb2 import UpdateDeckConfigsMode, UpdateDeckConfigsRequest as UpdateDeckConfigs
from anki.scheduler_pb2 import SchedulingState
from anki.scheduler.v3 import CardAnswer

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("YADAVAR_DATA") or os.path.join(HERE, "data")
DIST = os.path.join(HERE, "..", "yadavar-app", "dist")
PORT = int(os.environ.get("YADAVAR_PORT", "8765"))
NOTETYPE = "Ankio"  # the app's first name: every existing collection has its cards under it
SETTINGS_KEY = "ankio_settings"
# the end-to-end tests run their own server on a throw-away collection with this set: it adds the /api/test/* routes
TEST = os.environ.get("YADAVAR_TEST") == "1"

os.makedirs(DATA, exist_ok=True)
col = Collection(os.path.join(DATA, "collection.anki2"))


# ------------------------------------------------------------------ setup


def ensure_notetype():
    nt = col.models.by_name(NOTETYPE)
    if nt:
        return nt
    nt = col.models.new(NOTETYPE)
    for f in ("Name", "Front", "Back", "Extra"):
        col.models.add_field(nt, col.models.new_field(f))
    t = col.models.new_template("Card")
    t["qfmt"] = "{{Front}}"
    t["afmt"] = "{{FrontSide}}<hr id=answer>{{Back}}"
    col.models.add_template(nt, t)
    col.models.add_dict(nt)
    return col.models.by_name(NOTETYPE)


def ensure_limits():
    """Daily limits are lifted so a file shows every card that is ready (Anki's own limits still apply if raised)."""
    if col.get_config("ankio_limits_set"):
        return
    conf = col.decks.get_config(1)
    if conf:
        conf["new"]["perDay"] = 9999
        conf["rev"]["perDay"] = 9999
        col.decks.update_config(conf)
    col.set_config("ankio_limits_set", True)


def ensure_learn_ahead():
    """Anki's learn-ahead limit (20 min) shows a card due in 10 minutes *now* when nothing else is waiting. With 0 a card
    answered "again" really waits for its time."""
    if col.get_config("ankio_learnahead_set"):
        return
    col.set_config("collapseTime", 0)
    col.set_config("ankio_learnahead_set", True)


def export_backup() -> bytes:
    """The whole collection as one .colpkg (Anki's own package format)."""
    global col, notetype
    path = os.path.join(DATA, "export.colpkg")
    if os.path.exists(path):
        os.remove(path)
    col.export_collection_package(path, include_media=True, legacy=False)
    col.reopen()
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return data


def import_backup(data: bytes) -> None:
    """Replaces the whole collection with a .colpkg; the current one is saved to data/backups first."""
    global notetype
    os.makedirs(os.path.join(DATA, "backups"), exist_ok=True)
    safe = os.path.join(DATA, "backups", "before-import-%d.colpkg" % int(time.time()))
    col.export_collection_package(safe, include_media=True, legacy=False)
    col.reopen()
    incoming = os.path.join(DATA, "import.colpkg")
    with open(incoming, "wb") as f:
        f.write(data)
    col_path = os.path.join(DATA, "collection.anki2")
    base = col_path[: -len(".anki2")]
    col.close(downgrade=False)
    try:
        col._backend.import_collection_package(
            col_path=col_path, backup_path=incoming, media_folder=base + ".media", media_db=base + ".media.db"
        )
    finally:
        col.reopen()
        os.remove(incoming)
    notetype = ensure_notetype()
    col.set_config("ankio_media_refs_set", False)  # a backup from an older version: give its cards their references
    ensure_media_refs()


def ensure_steps():
    """One 10-minute learning step (Anki's own deck option): "good" on a new card graduates it at once."""
    if col.get_config("ankio_steps_set"):
        return
    set_deck_options(learn_steps=[10], relearn_steps=[10])
    col.set_config("ankio_steps_set", True)


notetype = ensure_notetype()
ensure_limits()


# ------------------------------------------------------------------ helpers


ROOT = 1  # Anki's "Default" deck: the cards at the top level


def deck_of(folder_id) -> int:
    return int(folder_id) if folder_id else ROOT


def folder_of(did: int):
    return None if did == ROOT else str(did)


def clean_name(name: str) -> str:
    return name.replace("::", ":").strip() or "بدون نام"


def sep_last(full: str) -> tuple[str, str]:
    parts = full.split("::")
    return "::".join(parts[:-1]), parts[-1]


def nodes_json() -> list[dict]:
    decks = {d.name: d.id for d in col.decks.all_names_and_ids(include_filtered=False)}
    out = []
    for name, did in decks.items():
        if did == 1:
            continue
        parent, short = sep_last(name)
        pid = decks.get(parent) if parent else None
        out.append(
            {
                "id": str(did),
                "parentId": str(pid) if pid else None,
                "name": short,
                "createdAt": did,
                "newLimit": col.decks.get(did).get("newLimit"),
            }
        )
    return out


def set_new_limit(did: int, limit):
    """Anki's own "new cards per day" for this one deck (its "this deck" limit); None = no limit of its own."""
    deck = col.decks.get(did)
    deck["newLimit"] = int(limit) if limit else None
    col.decks.save(deck)


def new_left_today() -> dict[int, int]:
    """For folders with a daily new-card limit: how many new cards Anki still shows today (its own deck tree counts)."""
    limited = {d.id for d in col.decks.all_names_and_ids(include_filtered=False) if col.decks.get(d.id).get("newLimit")}
    out: dict[int, int] = {}
    if not limited:
        return out
    stack = [col.sched.deck_due_tree()]
    while stack:
        node = stack.pop()
        if node.deck_id in limited:
            out[node.deck_id] = node.new_count
        stack.extend(node.children)
    return out


def recall_now(type_: int, queue: int, due: int, ivl: int, data: str, today: int, now: float, cutoff: int):
    """The chance (0..1) of remembering a card right now, and whether it comes from FSRS: (recall, fsrs), None for new
    cards.

    With FSRS: Anki's own formula from the card's memory state (review and learning cards alike), timed to the second
    from the last review ("lrt"). The classic scheduler has no memory model; its usual estimate is 90 % on the day a card
    falls due, falling the longer it waits. A card in its learning steps is measured the same way against its step: 90 %
    when the step is up."""
    if type_ not in (1, 2, 3):
        return None
    try:
        mem = json.loads(data) if data else {}
    except ValueError:
        mem = {}
    lrt = mem.get("lrt")
    s, decay = mem.get("s"), mem.get("decay") or 0.5
    if s:
        if lrt:
            elapsed = max(0.0, (now - lrt) / 86400)
        else:
            elapsed = max(0, today - (due - ivl)) if type_ == 2 else 0
        factor = 0.9 ** (1 / -decay) - 1
        return round((1 + factor * elapsed / s) ** -decay, 4), True
    if type_ == 2:
        if ivl <= 0:
            return None
        # in whole days, as the classic scheduler counts its intervals
        return round(0.9 ** (max(0, today - (due - ivl)) / ivl), 4), False
    if not lrt:
        return 0.9, False
    due_at = due if queue == 1 else cutoff - 86400 + (due - today) * 86400  # learning steps of a day or more: a day number
    step = max(60, due_at - lrt)
    return round(0.9 ** (max(0.0, now - lrt) / step), 4), False


def recall_json(type_, queue, due, ivl, data, today=None, now=None, cutoff=None) -> dict:
    """recall: the chance of remembering the card now; fsrs: whether FSRS measured it (its goal is then the desired
    retention, the classic estimate's goal is 90 %)."""
    r = recall_now(type_, queue, due, ivl, data or "", col.sched.today if today is None else today,
                   time.time() if now is None else now, col.sched.day_cutoff if cutoff is None else cutoff)
    return {"recall": r[0], "fsrs": r[1]} if r else {}


def due_ms(card) -> int:
    """Due time in ms. Anki stores review cards as a day number and (re)learning cards as epoch seconds."""
    if card.queue in (2, 3) or (card.type == 2 and card.queue < 0):
        day_start = col.sched.day_cutoff - 86400
        return (day_start + (card.due - col.sched.today) * 86400) * 1000
    if card.type in (1, 3):
        return card.due * 1000
    return int(time.time() * 1000)


def is_ready(card) -> bool:
    if card.queue < 0:  # suspended / buried
        return False
    if card.queue == 0:
        return True
    if card.queue == 1:
        return card.due <= int(time.time()) + col.get_config("collapseTime", 1200)
    return card.due <= col.sched.today


def card_json(card) -> dict:
    note = card.note()
    try:
        extra = json.loads(note["Extra"] or "{}")
    except ValueError:
        extra = {}
    empty = '<div dir="rtl"><br></div>'
    state = {0: "new", 1: "learning", 2: "review", 3: "learning"}.get(card.type, "new")
    return {
        "id": str(card.id),
        "folderId": folder_of(card.odid or card.did),
        "name": note["Name"],
        "front": {"html": note["Front"] or empty, "widgets": extra.get("fw", [])},
        "back": {"html": note["Back"] or empty, "widgets": extra.get("bw", [])},
        "layout": extra.get("layout"),
        "state": state,
        "ready": is_ready(card),
        "parked": card.queue < 0,
        "due": due_ms(card),
        "interval": card.ivl,
        "ease": card.factor / 1000 if card.factor else None,
        "relearn": card.type == 3,
        "reps": card.reps,
        "lapses": card.lapses,
        "createdAt": card.nid,
        **recall_json(card.type, card.queue, card.due, card.ivl, col.db.scalar("select data from cards where id = ?", card.id)),
    }


def all_cards_json() -> list[dict]:
    """The list view needs a card's name and schedule, not its pages: contents (and layout) are loaded when a card is opened."""
    from types import SimpleNamespace

    rows = col.db.all(
        "select c.id, c.nid, c.did, c.odid, c.type, c.queue, c.due, c.ivl, c.factor, c.reps, c.lapses, "
        "substr(n.flds, 1, instr(n.flds || char(31), char(31)) - 1), c.data "
        "from cards c join notes n on n.id = c.nid where n.mid = ? order by c.id",
        notetype["id"],
    )
    # folders with a daily new-card limit: only the next new cards in Anki's order (position) are shown today
    left = new_left_today()
    allowed: set[int] = set()
    if left:
        for did, n in left.items():
            if n > 0:
                allowed.update(col.db.list("select id from cards where did = ? and queue = 0 order by due, id limit ?", did, n))
    empty = '<div dir="rtl"><br></div>'
    out = []
    today, cutoff, collapse, now = col.sched.today, col.sched.day_cutoff, col.get_config("collapseTime", 1200), int(time.time())

    def ready(c):
        if c.queue < 0:
            return False
        if c.queue == 0:
            return c.did not in left or c.id in allowed
        return c.due <= now + collapse if c.queue == 1 else c.due <= today

    def due_of(c):
        if c.queue in (2, 3) or (c.type == 2 and c.queue < 0):
            return (cutoff - 86400 + (c.due - today) * 86400) * 1000
        return c.due * 1000 if c.type in (1, 3) else now * 1000

    for id_, nid, did, odid, type_, queue, due, ivl, factor, reps, lapses, name, data in rows:
        c = SimpleNamespace(id=id_, did=did, type=type_, queue=queue, due=due)
        out.append(
            {
                "id": str(id_),
                "folderId": folder_of(odid or did),
                "name": name,
                "front": {"html": empty, "widgets": []},
                "back": {"html": empty, "widgets": []},
                "light": True,
                "state": {0: "new", 1: "learning", 2: "review", 3: "learning"}.get(type_, "new"),
                "ready": ready(c),
                "parked": queue < 0,
                "due": due_of(c),
                "interval": ivl,
                "ease": factor / 1000 if factor else None,
                "relearn": type_ == 3,
                "reps": reps,
                "lapses": lapses,
                "createdAt": nid,
                **recall_json(type_, queue, due, ivl, data, today, now, cutoff),
            }
        )
    return out


def revlog_json() -> list[dict]:
    rows = col.db.all("select id, cid, ease from revlog where ease between 1 and 4 order by id")
    return [{"cardId": str(cid), "at": rid, "rating": ease} for rid, cid, ease in rows]


def settings_get() -> dict:
    return col.get_config(SETTINGS_KEY, {}) or {}


def snapshot() -> dict:
    return {
        "version": 1,
        "nodes": nodes_json(),
        "cards": all_cards_json(),
        "revlog": revlog_json(),
        "settings": settings_get(),
        "dayStart": (col.sched.day_cutoff - 86400) * 1000,
    }


def media_refs(extra: dict) -> str:
    """The card's pictures and sounds written the way Anki recognises them (<img src>, [sound:]), kept in the hidden
    Extra field: Anki's own tools (Check Media in Anki or AnkiDroid) then know the files are used and never clear them."""
    out = []
    for w in (extra.get("fw") or []) + (extra.get("bw") or []):
        m = w.get("mediaId")
        if m and w.get("kind") in ("image", "audio"):
            out.append(f"[sound:{m}]" if w["kind"] == "audio" else f"<img src='{m}'>")
    return "".join(out)


def ensure_media_refs():
    """Once: cards made before media_refs existed get their references (no undo step, nothing else changes)."""
    if col.get_config("ankio_media_refs_set", False):
        return
    changed = []
    for nid in col.find_notes(f'note:"{NOTETYPE}"'):
        note = col.get_note(nid)
        try:
            extra = json.loads(note["Extra"] or "{}")
        except ValueError:
            continue
        refs = media_refs(extra)
        if extra.get("media", "") != refs:
            extra["media"] = refs
            note["Extra"] = json.dumps(extra, ensure_ascii=False)
            changed.append(note)
    if changed:
        col.update_notes(changed, skip_undo_entry=True)
    col.set_config("ankio_media_refs_set", True)


def write_note(card_id: int | None, deck_id: int | None, body: dict):
    """Create (card_id None) or update a note from the UI's card payload."""
    if card_id is None:
        note = col.new_note(notetype)
        extra = {}
    else:
        card = col.get_card(card_id)
        note = card.note()
        extra = json.loads(note["Extra"] or "{}")
    fill_note(note, extra, body)
    if card_id is None:
        col.add_note(note, deck_id)
        return col.get_card(note.card_ids()[0])
    col.update_note(note)
    return col.get_card(card_id)


def add_notes(items: list) -> None:
    """(note, deck id) pairs added in ONE operation (one undo step, whatever the number of cards)."""
    if items:
        col.add_notes([AddNoteRequest(note=n, deck_id=d) for n, d in items])


def fill_note(note, extra: dict, body: dict):
    if "name" in body:
        note["Name"] = body["name"]
    if "front" in body:
        note["Front"] = body["front"]["html"]
        extra["fw"] = body["front"]["widgets"]
    if "back" in body:
        note["Back"] = body["back"]["html"]
        extra["bw"] = body["back"]["widgets"]
    if "layout" in body:
        extra["layout"] = body["layout"]
    extra["media"] = media_refs(extra)
    note["Extra"] = json.dumps(extra, ensure_ascii=False)


# ------------------------------------------------------------------ scheduling


def state_delay_ms(state: SchedulingState) -> int:
    """How long until the card is seen again after choosing this answer (read from Anki's own next states)."""
    kind = state.WhichOneof("kind")
    if kind == "filtered":
        inner = state.filtered
        kind = inner.WhichOneof("kind")
        node = getattr(inner, kind)
    else:
        inner = state.normal
        kind = inner.WhichOneof("kind")
        node = getattr(inner, kind)
    if kind == "learning":
        return node.scheduled_secs * 1000
    if kind == "relearning":
        return node.learning.scheduled_secs * 1000
    if kind == "review":
        return node.scheduled_days * 86400 * 1000
    if kind == "preview":
        return node.scheduled_secs * 1000
    return 0


def card_states(card_id: int) -> dict:
    s = col._backend.get_scheduling_states(card_id)
    out = {
        "card": card_json(col.get_card(card_id)),
        "delays": [state_delay_ms(x) for x in (s.again, s.hard, s.good, s.easy)],
    }
    if is_practice(card_id):
        out["practice"] = True
    return out


def is_practice(card_id: int) -> bool:
    """A card already reviewed today that is not due again yet (opened on its own, e.g. from the brain): an answer now
    is only practice. Anki would count every such answer as a real review, and FSRS raises the memory's stability with
    each one (a few "easy" in a row in one day would push it weeks away); so the schedule is left as it is. A card
    waiting in today's queue (learning steps, "again") is never practice."""
    row = col.db.first("select queue, due from cards where id = ?", card_id)
    if not row:
        return False
    queue, due = row
    today = col.sched.today
    due_now = queue == 0 or (queue in (1, 4) and due <= time.time()) or (queue in (2, 3) and due <= today)
    if due_now:
        return False
    start = (col.sched.day_cutoff - 86400) * 1000
    return bool(col.db.scalar("select count() from revlog where cid = ? and id >= ? and ease > 0", card_id, start))


def next_card(folder_id) -> dict:
    """The next card Anki wants studied among the cards that sit directly in this folder (or at the top level):
    queue order, learning steps, limits are all Anki's. Anki's queue of a deck also holds its subfolders' cards; those
    are skipped here (each folder is reviewed on its own), keeping Anki's order for the rest."""
    did = deck_of(folder_id)
    col.decks.set_current(did)
    nested = did != ROOT and bool(col.decks.children(did))
    q = col.sched.get_queued_cards(fetch_limit=100000 if nested else 1)
    if nested:
        mine = [c for c in q.cards if (c.card.original_deck_id or c.card.deck_id) == did]
        counts = {
            "new": sum(1 for c in mine if c.queue == 0),
            "learning": sum(1 for c in mine if c.queue == 1),
            "review": sum(1 for c in mine if c.queue == 2),
        }
    else:
        mine = list(q.cards)
        counts = {"new": q.new_count, "learning": q.learning_count, "review": q.review_count}
    if not mine:
        return {"card": None, "counts": counts}
    out = card_states(mine[0].card.id)
    out["counts"] = counts
    return out


RATINGS = {1: CardAnswer.AGAIN, 2: CardAnswer.HARD, 3: CardAnswer.GOOD, 4: CardAnswer.EASY}


def answer(card_id: int, rating: int, millis: int = 0) -> dict:
    if is_practice(card_id):
        return {"card": card_json(col.get_card(card_id)), "revlog": [], "practice": True}
    card = col.get_card(card_id)
    card.start_timer()  # build_answer reads Anki's card timer; the real time on screen is set just below
    states = col._backend.get_scheduling_states(card_id)
    answer_input = col.sched.build_answer(card=card, states=states, rating=RATINGS[rating])
    answer_input.milliseconds_taken = max(0, min(int(millis), 60000))
    top = col.sched.get_queued_cards(fetch_limit=1).cards
    if top and top[0].card.id == card_id:
        col.sched.answer_card(answer_input)
    else:
        # A folder is studied on its own, but Anki's queue for its deck also holds the subfolders' cards: when one of
        # those is ahead, Anki would refuse an answer for this card (and a refused answer wipes Anki's undo history).
        # "Grade now" (what Anki's card browser uses) applies the very same scheduling states as one undo step; it only
        # does not record the seconds spent (writing them into the review log by hand would also wipe the undo history).
        col._backend.grade_now(card_ids=[card_id], rating=RATINGS[rating])
    return {"card": card_json(col.get_card(card_id)), "revlog": revlog_json()[-1:]}


# ------------------------------------------------------------------ cut / copy / paste (one undo step per action)

FA = str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹")


def tx(fn):
    """Runs several Anki operations as ONE undo step (Anki's own merge of undo entries)."""
    start = col.undo_status().last_step
    out = fn()
    if col.undo_status().last_step - start > 1:
        try:
            col.merge_undo_entries(start + 1)  # steps are numbered from 1: this merges the ops done after `start`
        except InvalidInput:
            pass  # more steps than Anki keeps (about 30): the work is done, only its undo stays partial
    return out


def unique_deck_name(full: str) -> str:
    taken = {d.name.lower() for d in col.decks.all_names_and_ids(include_filtered=False)}
    if full.lower() not in taken:
        return full
    i = 2
    while f"{full} {str(i).translate(FA)}".lower() in taken:
        i += 1
    return f"{full} {str(i).translate(FA)}"


def deck_full(parent_id) -> str:
    return col.decks.name(int(parent_id)) if parent_id else ""


def import_cards(parent_id, name: str, cards: list[dict], new_per_day) -> dict:
    """Cards brought in from a file: a folder of their own (so its daily new-card limit leaves every other folder alone),
    its limit, and the cards in their order — one undo step."""
    parent = deck_full(parent_id)
    clean = clean_name(name)

    def run():
        did = col.decks.add_normal_deck_with_name(unique_deck_name(f"{parent}::{clean}" if parent else clean)).id
        if new_per_day:
            set_new_limit(did, new_per_day)
        items = []
        for c in cards:
            note = col.new_note(notetype)
            fill_note(note, {}, c)
            items.append((note, did))
        add_notes(items)
        return did

    did = tx(run)
    return next(n for n in nodes_json() if n["id"] == str(did))


def move_items(nodes, cards, parent_id):
    """Cut + paste: folders are renamed into the new parent (their subfolders and cards follow), cards change deck.
    Everything is ONE undo step."""
    parent = deck_full(parent_id)

    def run():
        if cards:
            did = deck_of(parent_id)
            moved = [int(i) for i in cards]
            col.set_deck(moved, did)
            # card names are unique within a folder: a moved card whose name is taken there gets a number
            taken = {col.get_card(c).note()["Name"].lower() for c in col.db.list("select id from cards where did = ?", did) if c not in moved}
            for cid in moved:
                note = col.get_card(cid).note()
                name = note["Name"]
                i = 2
                while name.lower() in taken:
                    name = f"{note['Name']} {str(i).translate(FA)}"
                    i += 1
                taken.add(name.lower())
                if name != note["Name"]:
                    note["Name"] = name
                    col.update_note(note)
        for sid in nodes:
            did = int(sid)
            cur = col.decks.name(did)
            if parent == cur or parent.startswith(cur + "::"):
                continue  # into itself
            short = sep_last(cur)[1]
            full = f"{parent}::{short}" if parent else short
            if full != cur:
                col.decks.rename(did, unique_deck_name(full))

    tx(run)


def copy_items(nodes, cards, parent_id):
    """Copy + paste: folders with everything below them, and cards. Copies are new cards (fresh schedule)."""
    parent = deck_full(parent_id)

    def run():
        items = copy_cards(cards, deck_of(parent_id)) if cards else []
        for sid in nodes:
            src = col.decks.name(int(sid))
            short = sep_last(src)[1]
            top = unique_deck_name(f"{parent}::{short}" if parent else short)
            tree = [d for d in col.decks.all_names_and_ids(include_filtered=False) if d.name == src or d.name.startswith(src + "::")]
            tree.sort(key=lambda d: d.name.count("::"))
            made = {}
            for d in tree:
                made[d.id] = col.decks.add_normal_deck_with_name(top + d.name[len(src):]).id
                if col.decks.get(d.id).get("newLimit"):  # an imported folder keeps its daily limit of new cards
                    set_new_limit(made[d.id], col.decks.get(d.id)["newLimit"])
            for d in tree:
                for cid in col.db.list("select id from cards where did = ?", d.id):
                    old = col.get_card(cid).note()
                    new = col.new_note(notetype)
                    for f in ("Name", "Front", "Back", "Extra"):
                        new[f] = old[f]
                    items.append((new, made[d.id]))
        add_notes(items)

    tx(run)


def copy_cards(ids, did: int) -> list:
    """Copies of the cards for deck `did` (a copy whose name is taken there gets a number), to be added by add_notes."""
    items = []
    taken = {col.get_card(c).note()["Name"].lower() for c in col.db.list("select id from cards where did = ?", did)}
    for cid in ids:
        old = col.get_card(int(cid)).note()
        new = col.new_note(notetype)
        name = old["Name"]
        i = 2
        while name.lower() in taken:
            name = f"{old['Name']} {str(i).translate(FA)}"
            i += 1
        taken.add(name.lower())
        new["Name"] = name
        for f in ("Front", "Back", "Extra"):
            new[f] = old[f]
        items.append((new, did))
    return items


def redo() -> dict:
    if not col.undo_status().redo:
        return {"ok": False}
    col.redo()
    return {"ok": True}


def undo() -> dict:
    status = col.undo_status()
    if not status.undo:
        return {"ok": False}
    col.undo()
    return {"ok": True}


# ------------------------------------------------------------------ FSRS (automatic switch-over)

FSRS_HARD_LIMIT = 900   # reviews: switch on no matter what
FSRS_MIN_ITEMS = 400    # Anki's own minimum for training parameters on your history
FSRS_MAX_RMSE = 0.06    # held-out calibration error (predicted vs actual recall)
FSRS_MIN_GAIN = 0.03    # log-loss must beat a "no-skill" predictor by at least 3 %


def review_count() -> int:
    return col.db.scalar("select count() from revlog where type in (0,1,2,3) and ease between 1 and 4") or 0


def fsrs_enabled() -> bool:
    return bool(col.decks.get_deck_configs_for_update(1).fsrs)


def deck_retention() -> float:
    cur = col.decks.get_deck_configs_for_update(1)
    return next(c.config for c in cur.all_config if c.config.id == cur.current_deck.config_id).config.desired_retention


def set_deck_options(*, fsrs: bool | None = None, params=None, retention: float | None = None, learn_steps=None, relearn_steps=None):
    """Writes to Anki's deck options through its own backend call (the same one the Anki options screen uses)."""
    cur = col.decks.get_deck_configs_for_update(1)
    cfg = next(c.config for c in cur.all_config if c.config.id == cur.current_deck.config_id)
    if params:
        del cfg.config.fsrs_params_6[:]
        cfg.config.fsrs_params_6.extend(params)
    if retention:
        cfg.config.desired_retention = retention
    if learn_steps:
        del cfg.config.learn_steps[:]
        cfg.config.learn_steps.extend(learn_steps)
    if relearn_steps:
        del cfg.config.relearn_steps[:]
        cfg.config.relearn_steps.extend(relearn_steps)
    col.decks.update_deck_configs(
        UpdateDeckConfigs(
            target_deck_id=1,
            configs=[cfg],
            mode=UpdateDeckConfigsMode.UPDATE_DECK_CONFIGS_MODE_NORMAL,
            card_state_customizer=cur.card_state_customizer,
            limits=cur.current_deck.limits,
            new_cards_ignore_review_limit=cur.new_cards_ignore_review_limit,
            fsrs=cur.fsrs if fsrs is None else fsrs,
            apply_all_parent_limits=cur.apply_all_parent_limits,
            fsrs_reschedule=False,
            fsrs_health_check=False,
        )
    )


def baseline_log_loss() -> float:
    """Log-loss of a predictor that always says "you remember with the average probability" (no memory model at all)."""
    ok, bad = (col.db.first("select sum(ease > 1), sum(ease = 1) from revlog where type = 1 and ease between 1 and 4") or (0, 0))
    ok, bad = ok or 0, bad or 0
    n = ok + bad
    if not n or not ok or not bad:
        return 0.0
    p = ok / n
    return -(p * math.log(p) + (1 - p) * math.log(1 - p))


def fsrs_status() -> dict:
    return {
        "enabled": fsrs_enabled(),
        "reviews": review_count(),
        "hardLimit": FSRS_HARD_LIMIT,
        "minItems": FSRS_MIN_ITEMS,
        "last": col.get_config("ankio_fsrs_check", None),
    }


def fsrs_check(force: bool = False) -> dict:
    """
    Decide whether FSRS should replace Anki's classic scheduler for this collection, and switch it on if so.
      * 900+ reviews: always switch on.
      * Otherwise, once there are enough items to train on (400), the parameters are trained on the older part of
        the history and tested on the newer part (Anki's own time-series evaluation). FSRS is switched on only if
        its predictions are well calibrated (RMSE <= 6 %) AND clearly better than a no-skill predictor (>= 3 %).
    Runs at most once a day (unless forced) and only while FSRS is off.
    """
    if fsrs_enabled():
        return fsrs_status()
    n = review_count()
    today = col.sched.today
    last = col.get_config("ankio_fsrs_check", None) or {}
    # below 900 reviews: train at most once a day (or after 20 more reviews); at 900 it switches on right away
    if not force and n < FSRS_HARD_LIMIT and (n < FSRS_MIN_ITEMS or (last.get("day") == today and last.get("reviews", 0) >= n - 20)):
        return fsrs_status()

    relearn_steps = 1
    result = {"day": today, "reviews": n, "enabled": False}
    comp = col._backend.compute_fsrs_params(
        search="", current_params=[], ignore_revlogs_before_ms=0, num_of_relearning_steps=relearn_steps, health_check=False
    )
    result["items"] = comp.fsrs_items
    params = list(comp.params)
    reason = None
    if comp.fsrs_items >= FSRS_MIN_ITEMS and params:
        # evaluate on held-out data using these parameters
        set_deck_options(fsrs=False, params=params)
        ev = col._backend.evaluate_params(search="", ignore_revlogs_before_ms=0, num_of_relearning_steps=relearn_steps)
        base = baseline_log_loss()
        result.update(rmse=ev.rmse_bins, logLoss=ev.log_loss, baseline=base)
        if n >= FSRS_HARD_LIMIT:
            reason = "reached %d reviews" % FSRS_HARD_LIMIT
        elif ev.rmse_bins <= FSRS_MAX_RMSE and base > 0 and ev.log_loss <= base * (1 - FSRS_MIN_GAIN):
            reason = "evidence: calibrated and beats the no-skill baseline"
    elif n >= FSRS_HARD_LIMIT:
        reason = "reached %d reviews" % FSRS_HARD_LIMIT
    if reason:
        retention = (settings_get() or {}).get("retention") or 0.9
        set_deck_options(fsrs=True, params=params or None, retention=float(retention))
        result.update(enabled=True, reason=reason, enabledAt=int(time.time() * 1000))
    col.set_config("ankio_fsrs_check", result)
    return fsrs_status()


# ------------------------------------------------------------------ statistics


def _arr(x):
    return list(x)


def stats() -> dict:
    """Anki's own statistics (the numbers behind its Statistics screen) plus per-day review data from the revlog."""
    g = col._backend.graphs(search="", days=0)
    cutoff = col.sched.day_cutoff
    day0 = cutoff - 86400  # start of Anki's today (seconds)

    per_day: dict[int, dict] = {}
    rows = col.db.all(
        "select r.id, r.time, r.cid, coalesce(nullif(c.odid, 0), c.did) from revlog r "
        "left join cards c on c.id = r.cid where r.type < 4 and r.id >= ?",
        (day0 - 40 * 86400) * 1000,
    )
    for rid, ms, cid, did in rows:
        off = (rid // 1000 - day0) // 86400
        d = per_day.setdefault(off, {"cards": 0, "ms": 0, "files": set()})
        d["cards"] += 1
        d["ms"] += ms
        if did:
            d["files"].add(did)
    days = [
        {
            "day": o,
            "cards": per_day.get(o, {}).get("cards", 0),
            "files": len(per_day.get(o, {}).get("files", ())),
            "minutes": round(per_day.get(o, {}).get("ms", 0) / 60000, 1),
        }
        for o in range(-29, 1)
    ]

    future = {}
    for off, n in g.future_due.future_due.items():
        key = max(0, off)  # overdue cards count as due today
        future[key] = future.get(key, 0) + n

    cc = g.card_counts.excluding_inactive

    def btn(b):
        return {"learning": _arr(b.learning), "young": _arr(b.young), "mature": _arr(b.mature)}

    def tr(t):
        return {"youngPassed": t.young_passed, "youngFailed": t.young_failed,
                "maturePassed": t.mature_passed, "matureFailed": t.mature_failed}

    t = g.today
    return {
        "dayStart": day0 * 1000,
        "days": days,
        "future": [{"day": o, "due": future.get(o, 0)} for o in range(0, 15)],
        "cardCounts": {"new": cc.newCards, "learn": cc.learn, "relearn": cc.relearn, "young": cc.young,
                       "mature": cc.mature, "suspended": cc.suspended, "buried": cc.buried},
        "buttons": {"month": btn(g.buttons.one_month), "quarter": btn(g.buttons.three_months),
                    "year": btn(g.buttons.one_year), "all": btn(g.buttons.all_time)},
        "retention": {"today": tr(g.true_retention.today), "yesterday": tr(g.true_retention.yesterday),
                      "week": tr(g.true_retention.week), "month": tr(g.true_retention.month),
                      "year": tr(g.true_retention.year), "all": tr(g.true_retention.all_time)},
        "today": {"answers": t.answer_count, "minutes": round(t.answer_millis / 60000, 1), "correct": t.correct_count},
        "fsrs": bool(g.fsrs),
    }


# ------------------------------------------------------------------ http


class Handler(BaseHTTPRequestHandler):
    server_version = "Yadavar/1"
    # one request at a time: a browser's idle pre-opened connection must not block everyone else
    timeout = 10

    def log_message(self, fmt, *args):  # quiet
        pass

    def _send(self, code: int, body: bytes, ctype: str = "application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        try:
            if url.path == "/api/snapshot":
                return self._json(snapshot())
            if url.path == "/api/export":
                return self._send(200, export_backup(), "application/octet-stream")
            if url.path == "/api/fsrs":
                return self._json(fsrs_status())
            if url.path == "/api/stats":
                return self._json(stats())
            if url.path == "/api/next":
                return self._json(next_card((q.get("folder") or [""])[0]))
            if url.path.startswith("/api/card/"):
                cid = int(url.path.rsplit("/", 1)[1])
                return self._json(card_states(cid))
            if url.path.startswith("/api/media/"):
                name = os.path.basename(urllib.parse.unquote(url.path[len("/api/media/"):]))
                path = os.path.join(col.media.dir(), name)
                if not os.path.isfile(path):
                    return self._json({"error": "not found"}, 404)
                with open(path, "rb") as f:
                    data = f.read()
                return self._send(200, data, mimetypes.guess_type(name)[0] or "application/octet-stream")
            return self._static(url.path)
        except Exception as e:  # noqa: BLE001
            self._json({"error": str(e)}, 500)

    def _static(self, path: str):
        root = os.path.abspath(DIST)
        rel = path.lstrip("/") or "index.html"
        full = os.path.abspath(os.path.join(root, rel))
        if not full.startswith(root) or not os.path.isfile(full):
            full = os.path.join(root, "index.html")
        if not os.path.isfile(full):
            return self._send(404, b"UI not built (run npm run build in yadavar-app)", "text/plain")
        with open(full, "rb") as f:
            data = f.read()
        self._send(200, data, mimetypes.guess_type(full)[0] or "application/octet-stream")

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            if url.path == "/api/import":
                import_backup(raw)
                return self._json({"ok": True})
            if url.path == "/api/media":
                q = urllib.parse.parse_qs(url.query)
                fname = col.media.write_data(q.get("name", ["file"])[0], raw)
                return self._json({"name": fname})
            body = json.loads(raw.decode("utf-8")) if raw else {}
            return self._json(self.route(url.path, body))
        except Exception as e:  # noqa: BLE001
            print("error:", url.path, repr(e), file=sys.stderr)
            traceback.print_exc()
            self._json({"error": str(e)}, 500)

    def route(self, path: str, b: dict):
        if path == "/api/node":
            name = clean_name(b["name"])
            parent = col.decks.get(int(b["parentId"])) if b.get("parentId") else None
            full = f"{parent['name']}::{name}" if parent else name
            did = col.decks.add_normal_deck_with_name(unique_deck_name(full)).id
            return next(n for n in nodes_json() if n["id"] == str(did))
        if path == "/api/node/rename":
            did = int(b["id"])
            parent, _ = sep_last(col.decks.name(did))
            name = clean_name(b["name"])
            full = f"{parent}::{name}" if parent else name
            if full.lower() != col.decks.name(did).lower():
                full = unique_deck_name(full)  # e.g. a top-level folder called like Anki's "Default" deck
            col.decks.rename(did, full)
            return {"ok": True, "name": sep_last(full)[1]}  # the name Anki keeps (it may differ from the one asked)
        if path == "/api/delete":
            def run():
                if b.get("cards"):
                    col.remove_notes_by_card([int(i) for i in b["cards"]])
                names = [col.decks.name(int(i)) for i in b.get("nodes") or []]
                doomed = [d.id for d in col.decks.all_names_and_ids() if any(d.name == n or d.name.startswith(n + "::") for n in names)]
                if doomed:
                    col.decks.remove(doomed)

            tx(run)
            return {"ok": True}
        if path == "/api/card":
            card = write_note(None, deck_of(b.get("folderId")), b)
            return card_json(card)
        if path == "/api/cards/import":  # (not /api/import: that one restores a whole backup)
            return import_cards(b.get("parentId"), b["name"], b["cards"], b.get("newPerDay"))
        if path == "/api/node/limit":
            set_new_limit(int(b["id"]), b.get("limit"))
            return {"ok": True}
        if path == "/api/card/update":
            return card_json(write_note(int(b["id"]), None, b))
        if path == "/api/move":
            move_items(b.get("nodes") or [], b.get("cards") or [], b.get("to"))
            return {"ok": True}
        if path == "/api/copy":
            copy_items(b.get("nodes") or [], b.get("cards") or [], b.get("to"))
            return {"ok": True}
        if path == "/api/redo":
            return redo()
        if path == "/api/media/remove":  # only the given files, and only those no card uses (Anki's Check Media)
            unused = set(col.media.check().unused)
            names = [n for n in b.get("names") or [] if n in unused]
            if names:
                col.media.trash_files(names)
                col.media.empty_trash()
            return {"removed": names}
        if path == "/api/cardfull":
            return card_json(col.get_card(int(b["id"])))
        if path == "/api/answer":
            return answer(int(b["cardId"]), int(b["rating"]), int(b.get("millis", 0)))
        if path == "/api/undo":
            return undo()
        if path == "/api/settings":
            col.set_config(SETTINGS_KEY, b)
            # only a real change of the goal touches Anki's options (that is an undo step: it would end review undo)
            if b.get("retention") and abs(deck_retention() - float(b["retention"])) > 1e-4:
                set_deck_options(retention=float(b["retention"]))
            return {"ok": True}
        if path == "/api/fsrs/check":
            return fsrs_check(bool(b.get("force")))
        if path == "/api/reset":
            col.decks.remove([d.id for d in col.decks.all_names_and_ids() if d.id != 1])
            col.remove_notes(col.find_notes(f'note:"{NOTETYPE}"'))
            return {"ok": True}
        if TEST and path.startswith("/api/test/"):
            return test_route(path, b)
        raise ValueError("unknown route " + path)


def test_route(path: str, b: dict) -> dict:
    """Only with YADAVAR_TEST=1 (the end-to-end tests): states that would otherwise take days of real time."""
    global notetype
    if path == "/api/test/wipe":  # a fresh collection: no folders, cards, history, FSRS or settings
        col.decks.remove([d.id for d in col.decks.all_names_and_ids() if d.id != 1])
        col.remove_notes(col.find_notes(f'note:"{NOTETYPE}"'))
        col.db.execute("delete from revlog")
        col.set_config(SETTINGS_KEY, {})
        col.remove_config("ankio_fsrs_check")
        set_deck_options(fsrs=False, retention=0.9, learn_steps=[10], relearn_steps=[10])
        col.close()
        col.reopen()
        return {"ok": True}
    if path == "/api/test/steps":  # short learning steps (minutes): an "again" card comes back while a test waits for real
        set_deck_options(learn_steps=b["learn"], relearn_steps=b["learn"])
        return {"ok": True}
    if path == "/api/test/grade":  # Anki's "grade now" for many cards at once (one review each)
        col._backend.grade_now(card_ids=[int(i) for i in b["ids"]], rating=RATINGS[int(b["rating"])])
        return {"ok": True}
    if path == "/api/test/shift":  # everything that happened moves `seconds` into the past (whole days: the calendar too)
        sec = int(b["seconds"])
        days = sec // 86400
        if days:
            col.db.execute("update col set crt = crt - ?", days * 86400)
        col.db.execute("update revlog set id = id - ?", sec * 1000)
        col.db.execute("update cards set due = due - ? where queue = 1", sec)
        col.db.execute("update cards set data = json_set(data, '$.lrt', json_extract(data, '$.lrt') - ?) "
                       "where json_extract(data, '$.lrt') is not null", sec)
        col.close()
        col.reopen()
        return {"ok": True}
    if path == "/api/test/revlog":  # the raw review log: when, which card, the grade, the time taken, the kind
        return {"rows": col.db.all("select id, cid, ease, time, type from revlog order by id")}
    if path == "/api/test/suspend":
        col.sched.suspend_cards([int(i) for i in b["ids"]])
        return {"ok": True}
    raise ValueError("unknown route " + path)


if __name__ == "__main__":
    ensure_steps()
    ensure_learn_ahead()
    ensure_media_refs()
    srv = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Yadavar server on http://localhost:{PORT}  (Anki backend, collection: {DATA})")
    try:
        srv.serve_forever()
    finally:
        col.close()
