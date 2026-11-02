"""
Yadavar audit: scheduling, FSRS switch-over and storage. Nothing here touches your real collection: everything runs on
throw-away copies in a temp folder.

    .venv\\Scripts\\python verify.py          (a few minutes; VERIFY_DAYS=40 for a shorter run)

1. Scheduling. The same weeks of reviewing (fixed answers per card and day, a few skipped days) are run three ways on
   identical copies of one collection:
       A  Yadavar's PC server (server.py: next card per folder, answer)
       T  Yadavar's phone engine (src/lib/engine/ankiEngine.ts, on the same Anki backend the phone app ships)
       R  Anki itself: the same answers given through Anki's official answer path (what its reviewer calls).
   Anki's load balancing (it nudges a new interval within its random range towards quieter days) depends on the order
   in which cards are answered and on Anki's study queue, so this run has it off: then every card's schedule (due date,
   interval, ease, steps, lapses, FSRS memory state) and the whole review history must come out exactly the same,
   day after day. The cards the app lists as "due today" must be exactly the ones Anki's own queue holds, a folder must
   only serve its own cards, and the phone must study the same cards with the same answers as the PC.
   A second run uses Anki's defaults (load balancing on, as in the app) and checks that nothing is ever missed or lost.
2. FSRS. No training before 400 reviews, the switch at 900 at the latest (and on the same day on PC and phone), every
   studied card gets a memory state, desired retention is set, and scheduling after the switch still matches Anki's.
3. Storage. A server killed without warning loses nothing that was confirmed; a backup file brings back everything
   (cards, history, schedule, settings, FSRS state, pictures, sounds); an undo of an answer restores the card exactly,
   also in a folder whose subfolders have cards due first; Anki's own Check Media sees every card file as used.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = tempfile.mkdtemp(prefix="yadavar-verify-")
os.environ["YADAVAR_DATA"] = os.path.join(WORK, "boot")
sys.path.insert(0, HERE)

import server as S  # noqa: E402  (opens a throw-away collection in WORK/boot)

BOOT = S.col  # Anki locks a collection file: this one stays open and is reused for the restore test
from anki.collection import Collection  # noqa: E402
from anki.deck_config_pb2 import UpdateDeckConfigsMode, UpdateDeckConfigsRequest  # noqa: E402
from anki.scheduler.v3 import CardAnswer  # noqa: E402

DAYS = int(os.environ.get("VERIFY_DAYS", "75"))
SKIPPED = {30, 31, 32, 33, 34, 50, 51}  # days without any studying: cards become overdue
MS = 5000
RATING = {1: CardAnswer.AGAIN, 2: CardAnswer.HARD, 3: CardAnswer.GOOD, 4: CardAnswer.EASY}

failures: list[str] = []


def check(name: str, ok: bool, extra=None):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok or extra is None else f"   {extra}"), flush=True)
    if not ok:
        failures.append(name)


def rating(cid: int, day: int, reps: int) -> int:
    """The answer given to a card: the same in every path (also in tools/verify-engine.ts)."""
    h = ((cid % 1000003) * 31 + day * 17 + reps * 7) % 100
    return 1 if h < 10 else 2 if h < 20 else 3 if h < 88 else 4


# ------------------------------------------------------------------ the collection everything starts from


def use(path: str) -> Collection:
    S.col = Collection(path)
    S.notetype = S.ensure_notetype()
    return S.col


def build_base(path: str, load_balance: bool):
    col = use(path)
    col.load_balancer_enabled = load_balance
    S.ensure_limits()
    S.ensure_steps()
    S.ensure_learn_ahead()
    lang = col.decks.add_normal_deck_with_name("زبان").id
    words = col.decks.add_normal_deck_with_name("زبان::لغات").id
    math = col.decks.add_normal_deck_with_name("ریاضی").id
    side = lambda t: {"html": "", "widgets": [{"id": "t", "kind": "text", "mediaId": "", "x": 0, "y": 0, "w": 100, "h": 30, "html": t}]}  # noqa: E731
    for did, n in ((S.ROOT, 40), (lang, 40), (words, 45), (math, 40)):
        for i in range(n):
            S.write_note(None, did, {"name": f"c{did}-{i}", "front": side(f"q{i}"), "back": side(f"a{i}")})
    col.close()


# The next day: the collection's calendar moves on a day, and everything that happened so far (review times, last
# review times) moves a day into the past with it, so FSRS sees real gaps between reviews. Also in verify-engine.ts.
NEXT_DAY = [
    "update col set crt = crt - 86400",
    "update revlog set id = id - 86400000",
    "update cards set data = json_set(data, '$.lrt', json_extract(data, '$.lrt') - 86400) "
    "where json_extract(data, '$.lrt') is not null",
]


def shift_day(path: str):
    col = Collection(path)
    for q in NEXT_DAY:
        col.db.execute(q)
    col.close()


# ------------------------------------------------------------------ state snapshots and comparison


def state(col: Collection) -> dict:
    cards = {}
    for cid, did, odid, typ, queue, due, ivl, factor, reps, lapses, left, data in col.db.all(
        "select id, did, odid, type, queue, due, ivl, factor, reps, lapses, left, data from cards order by id"
    ):
        cards[cid] = dict(did=did, odid=odid, type=typ, queue=queue, due=due, ivl=ivl, factor=factor, reps=reps,
                          lapses=lapses, left=left, data=data or "")
    revlog: dict[int, list] = {}
    for cid, ease, ivl, last, factor, typ in col.db.all("select cid, ease, ivl, lastIvl, factor, type from revlog order by id"):
        revlog.setdefault(cid, []).append([ease, ivl, last, factor, typ])
    return {"cards": cards, "revlog": revlog}


def diff(a: dict, b: dict, limit=5) -> list[str]:
    out = []
    ca, cb = a["cards"], b["cards"]
    if set(ca) != set(cb):
        return [f"different cards: {len(ca)} vs {len(cb)}"]
    for cid in ca:
        x, y = ca[cid], cb[cid]
        for k in ("did", "odid", "type", "queue", "ivl", "factor", "reps", "lapses", "left"):
            if x[k] != y[k]:
                out.append(f"card {cid} {k}: {x[k]} vs {y[k]}")
        # learning cards are due at a clock time (seconds): the runs happen a little apart
        if abs(x["due"] - y["due"]) > (900 if x["queue"] == 1 else 0):
            out.append(f"card {cid} due: {x['due']} vs {y['due']}")
        dx, dy = json.loads(x["data"] or "{}"), json.loads(y["data"] or "{}")
        for k in set(dx) | set(dy):
            vx, vy = dx.get(k), dy.get(k)
            if k == "lrt":  # last review time, a clock time
                ok = vx is not None and vy is not None and abs(vx - vy) < 900
            elif isinstance(vx, (int, float)) and isinstance(vy, (int, float)):
                ok = abs(vx - vy) <= 1e-4 * max(1.0, abs(vx))
            else:
                ok = vx == vy
            if not ok:
                out.append(f"card {cid} data.{k}: {vx} vs {vy}")
    ra, rb = a["revlog"], b["revlog"]
    for cid in set(ra) | set(rb):
        if ra.get(cid) != rb.get(cid):
            out.append(f"card {cid} review log: {ra.get(cid)} vs {rb.get(cid)}")
    return out[:limit]


def anki_due_now(col: Collection) -> set[int]:
    """Every card Anki would show today, asking each folder (deck) for its whole queue."""
    ids: set[int] = set()
    for d in col.decks.all_names_and_ids(include_filtered=False):
        col.decks.set_current(d.id)
        ids |= {c.card.id for c in col.sched.get_queued_cards(fetch_limit=100000).cards}
    return ids


def learning_left(col: Collection) -> int:
    return col.db.scalar("select count() from cards where queue = 1") or 0


# ------------------------------------------------------------------ R: Anki itself


def reference_answer(col: Collection, cid: int, rate: int):
    """Anki's official answer path (what its reviewer calls): states from the scheduler, answer_card."""
    card = col.get_card(cid)
    card.start_timer()
    states = col._backend.get_scheduling_states(cid)
    ans = col.sched.build_answer(card=card, states=states, rating=RATING[rate])
    ans.milliseconds_taken = MS
    col.sched.answer_card(ans)


def reference_day(col: Collection, rounds: list[list]):
    for k, answers in enumerate(rounds):
        if k:
            col.db.execute("update cards set due = due - 3600 where queue = 1")  # an hour later
        for cid, rate in answers:
            reference_answer(col, cid, rate)


def train_fsrs(col: Collection) -> list[float]:
    """Anki's "Optimize" button: FSRS parameters trained on the collection's whole history."""
    return list(col._backend.compute_fsrs_params(search="", current_params=[], ignore_revlogs_before_ms=0,
                                                 num_of_relearning_steps=1, health_check=False).params)


def saved_fsrs_params(col: Collection) -> list[float]:
    cur = col.decks.get_deck_configs_for_update(1)
    return list(next(c.config for c in cur.all_config if c.config.id == cur.current_deck.config_id).config.fsrs_params_6)


def reference_fsrs_on(col: Collection, retention: float, params: list[float]):
    """What Anki's deck options screen does when FSRS is switched on, with the given (trained) parameters."""
    cur = col.decks.get_deck_configs_for_update(1)
    cfg = next(c.config for c in cur.all_config if c.config.id == cur.current_deck.config_id)
    if params:
        del cfg.config.fsrs_params_6[:]
        cfg.config.fsrs_params_6.extend(params)
    cfg.config.desired_retention = retention
    col.decks.update_deck_configs(UpdateDeckConfigsRequest(
        target_deck_id=1, configs=[cfg], mode=UpdateDeckConfigsMode.UPDATE_DECK_CONFIGS_MODE_NORMAL,
        card_state_customizer=cur.card_state_customizer, limits=cur.current_deck.limits,
        new_cards_ignore_review_limit=cur.new_cards_ignore_review_limit, fsrs=True,
        apply_all_parent_limits=cur.apply_all_parent_limits, fsrs_reschedule=False, fsrs_health_check=False))


# ------------------------------------------------------------------ A: Yadavar's server


def server_day(day: int) -> dict:
    col = S.col
    shown = {int(c["id"]) for c in S.all_cards_json() if c["ready"]}
    due = anki_due_now(col)
    wrong_folder = 0
    folders = [None] + [n["id"] for n in S.nodes_json()]
    rounds: list[list] = []
    for k in range(8):
        if k:
            col.db.execute("update cards set due = due - 3600 where queue = 1")  # an hour later: learning cards are due
        answers = []
        for f in folders:
            while True:
                r = S.next_card(f)
                if not r["card"]:
                    break
                if r["card"]["folderId"] != f:
                    wrong_folder += 1
                cid = int(r["card"]["id"])
                rate = rating(cid, day, col.get_card(cid).reps)
                S.answer(cid, rate, MS)
                answers.append([cid, rate])
        rounds.append(answers)
        if not learning_left(col):
            break
    left_after = {int(c["id"]) for c in S.all_cards_json() if c["ready"]}
    return {"shown": shown, "due": due, "wrong_folder": wrong_folder, "left_after": left_after, "rounds": rounds}


# ------------------------------------------------------------------ 1 + 2: the simulation


def simulate():
    print(f"\n=== 1/2. Scheduling and FSRS: {DAYS} days, three ways (load balancing off: exact comparison) ===", flush=True)
    base = os.path.join(WORK, "base.anki2")
    build_base(base, load_balance=False)
    paths = {k: os.path.join(WORK, f"{k}.anki2") for k in "RAT"}
    for p in paths.values():
        shutil.copy(base, p)

    r_states: dict[int, dict] = {}
    a_rounds: dict[int, list] = {}
    a_fsrs_day = None
    switch_reviews = None
    first_training_reviews = None
    early_config = False
    mismatch_days = []
    shown_problems = []
    folder_problems = 0
    for day in range(DAYS):
        R = Collection(paths["R"])
        A = use(paths["A"])
        if day not in SKIPPED:
            info = server_day(day)
            a_rounds[day] = info["rounds"]
            reference_day(R, info["rounds"])
            if info["shown"] != info["due"]:
                shown_problems.append((day, len(info["shown"] - info["due"]), len(info["due"] - info["shown"])))
            if info["left_after"]:
                shown_problems.append((day, "still listed after studying", len(info["left_after"])))
            folder_problems += info["wrong_folder"]
        # the app checks FSRS after every review session
        reviews = S.review_count()
        before = A.get_config("ankio_fsrs_check", None)
        st = S.fsrs_check()
        after = A.get_config("ankio_fsrs_check", None)
        if reviews < S.FSRS_MIN_ITEMS and after != before:
            early_config = True
        if after != before and first_training_reviews is None and after is not None:
            first_training_reviews = reviews
        if st["enabled"] and a_fsrs_day is None:
            a_fsrs_day = day
            switch_reviews = reviews
            # The reference gets the server's parameters rather than training its own: training also uses the seconds
            # between a card's same-day reviews, and the two copies are answered a few milliseconds apart, so their
            # trained parameters differ in the 5th digit (and every memory state with them). That the server saved
            # exactly what Anki trains on the server's own history is checked on its own.
            saved = saved_fsrs_params(A)
            own = train_fsrs(A)
            check("FSRS: the server saved exactly the parameters Anki trains on its history",
                  len(saved) > 0 and [round(x, 5) for x in saved] == [round(x, 5) for x in own], (saved[:3], own[:3]))
            reference_fsrs_on(R, float((S.settings_get() or {}).get("retention") or 0.9), saved)
            print(f"      FSRS switched on: day {day}, {reviews} reviews ({(st['last'] or {}).get('reason')})", flush=True)
            # every card studied so far now has a memory state, on both sides
            for name, c in (("server", A), ("reference", R)):
                missing = c.db.scalar("select count() from cards where reps > 0 and (data is null or data not like '%\"s\":%')")
                check(f"FSRS: every studied card got a memory state ({name})", missing == 0, missing)
            cur = A.decks.get_deck_configs_for_update(1)
            cfg = next(x.config for x in cur.all_config if x.config.id == cur.current_deck.config_id)
            check("FSRS: switched on, trained parameters and desired retention 90% saved",
                  cur.fsrs and len(cfg.config.fsrs_params_6) > 0 and abs(cfg.config.desired_retention - 0.9) < 1e-6,
                  (cur.fsrs, len(cfg.config.fsrs_params_6), cfg.config.desired_retention))
        sa, sr = state(A), state(R)
        d = diff(sa, sr)
        if d:
            mismatch_days.append((day, d))
        r_states[day] = sr
        R.close()
        A.close()
        shift_day(paths["R"])
        shift_day(paths["A"])

    R = Collection(paths["R"])
    total_reviews = R.db.scalar("select count() from revlog")
    R.close()
    print(f"      {total_reviews} answers in total; FSRS on from day {a_fsrs_day}", flush=True)
    check("server: every card's schedule and history equal Anki's own, every day", not mismatch_days,
          mismatch_days[:1])
    check("server: 'due today' list = exactly the cards Anki asks for; nothing left after studying", not shown_problems,
          shown_problems[:3])
    check("server: a folder only serves its own cards", folder_problems == 0, folder_problems)
    check("FSRS: no training / no change before 400 reviews", not early_config)
    check("FSRS: training starts from 400 reviews",
          first_training_reviews is not None and first_training_reviews >= S.FSRS_MIN_ITEMS, first_training_reviews)
    check("FSRS: switched on (by 900 reviews at the latest)", a_fsrs_day is not None and switch_reviews is not None and
          switch_reviews < S.FSRS_HARD_LIMIT + 200, (a_fsrs_day, switch_reviews))

    # ---- T: the phone engine, the same days
    print("      phone engine: running the same days…", flush=True)
    out = os.path.join(WORK, "T.json")
    py = sys.executable
    tsx = subprocess.run(
        ["npx", "tsx", "tools/verify-engine.ts", paths["T"], str(DAYS), ",".join(map(str, sorted(SKIPPED))), out],
        cwd=os.path.join(HERE, "..", "yadavar-app"), env={**os.environ, "YADAVAR_PY": py}, shell=os.name == "nt",
        capture_output=True, text=True, timeout=3600,
    )
    if tsx.returncode != 0 or not os.path.exists(out):
        check("phone engine ran", False, (tsx.stdout[-800:], tsx.stderr[-800:]))
        return paths
    days = json.load(open(out, encoding="utf-8"))
    t_switch = next((rec["day"] for rec in days if rec["fsrs"]), None)
    # Up to the first switch (PC or phone) both must match Anki exactly. Between 400 and 900 reviews FSRS switches on
    # early only when proven better on the history, and FSRS-6 also uses the seconds between a card's same-day reviews,
    # which in two separate simulations differ a little (the phone run is slower): a borderline proof can tip on
    # different days. Each side's decision is checked against the rule on its own numbers instead.
    switches = [d for d in (a_fsrs_day, t_switch) if d is not None]
    cut = min(switches) if switches else None
    t_mismatch, t_shown, t_folder, t_fsrs_day, t_order = [], [], 0, None, []
    t_states = {}
    for rec in days:
        day = rec["day"]
        st = {"cards": {int(k): v for k, v in rec["state"]["cards"].items()},
              "revlog": {int(k): v for k, v in rec["state"]["revlog"].items()}}
        t_states[day] = st
        # up to the switch, the phone must match Anki exactly. From the switch on, FSRS is trained on the history, and
        # FSRS-6 also uses the seconds between a card's reviews on the same day — which in this simulation depend on
        # how fast each run went (the phone run is slower). So after the switch the phone is compared with Anki
        # replaying the phone's own history (below).
        if cut is None or day < cut:
            d = diff(st, r_states[day])
            if d:
                t_mismatch.append((day, d))
        if day not in SKIPPED and set(rec["shown"]) != set(rec["due"]):
            t_shown.append(day)
        if rec["leftAfter"]:
            t_shown.append((day, "left", rec["leftAfter"]))
        t_folder += rec["wrongFolder"]
        # same cards, same answers (Anki shuffles reviews due the same day by each card's last change, a clock time,
        # so the order itself may differ between two runs)
        if (cut is None or day <= cut) and day not in SKIPPED and \
                sorted(sum(rec["rounds"], [])) != sorted(sum(a_rounds.get(day, []), [])):
            t_order.append(day)
        if rec["fsrs"] and t_fsrs_day is None:
            t_fsrs_day = day
    check("phone: every card's schedule and history equal Anki's own, every day until FSRS", not t_mismatch, t_mismatch[:1])
    check("phone: 'due today' list = exactly the cards Anki asks for", not t_shown, t_shown[:3])
    check("phone: a folder only serves its own cards", t_folder == 0, t_folder)
    check("phone: studies the same cards with the same answers as the PC, every day until FSRS", not t_order, t_order[:5])
    t_last = None
    snap0 = paths["T"].replace(".anki2", "-fsrs.anki2")
    if os.path.exists(snap0):
        c = Collection(snap0)
        t_last = c.get_config("ankio_fsrs_check", None) or {}
        c.close()
    rule = bool(t_last) and t_last.get("enabled") and (
        t_last["reviews"] >= S.FSRS_HARD_LIMIT or
        (t_last.get("rmse", 1) <= S.FSRS_MAX_RMSE and t_last.get("logLoss", 9) <= t_last.get("baseline", 0) * (1 - S.FSRS_MIN_GAIN)))
    check("phone: switched FSRS on by the rule (900 reviews, or proven better on its own history)", rule, t_last)

    # ---- the phone after the switch: Anki itself, from the phone's own collection at the switch, given the phone's
    # answers, must end up exactly where the phone did, day after day
    snap = paths["T"].replace(".anki2", "-fsrs.anki2")
    if t_switch is not None and os.path.exists(snap):
        RT = Collection(snap)
        cur = RT.decks.get_deck_configs_for_update(1)
        saved = list(cur.all_config[0].config.config.fsrs_params_6)
        RT.db.execute("update col set crt = crt + 86400")  # back to the switch day, to train on exactly that history
        RT.db.execute("update revlog set id = id + 86400000")
        RT.db.execute("update cards set data = json_set(data, '$.lrt', json_extract(data, '$.lrt') + 86400) "
                      "where json_extract(data, '$.lrt') is not null")
        RT.close()
        RT = Collection(snap)
        own = train_fsrs(RT)
        RT.close()
        shift_day(snap)
        replay = snap.replace("-fsrs.anki2", "-replay.anki2")  # the switch-day copy stays as it was (for a look later)
        shutil.copy(snap, replay)
        # the copy must be the phone's collection at the end of the switch day (times moved a day back already)
        RT = Collection(replay)
        start = state(RT)
        RT.close()
        for c in start["cards"].values():
            d = json.loads(c["data"] or "{}")
            if "lrt" in d:
                d["lrt"] += 86400
                c["data"] = json.dumps(d)
        check("phone: the collection at the switch is exactly the phone's state that day", not diff(start, t_states[t_switch]),
              diff(start, t_states[t_switch])[:2])
        check("phone: FSRS saved exactly the parameters Anki trains on the phone's own history",
              cur.fsrs and len(saved) > 0 and [round(x, 5) for x in saved] == [round(x, 5) for x in own],
              (len(saved), saved[:3], own[:3]))
        rounds = {rec["day"]: rec["rounds"] for rec in days}
        after = []
        for day in range(t_switch + 1, DAYS):
            RT = Collection(replay)
            if day not in SKIPPED:
                reference_day(RT, rounds[day])
            d = diff(t_states[day], state(RT))
            if d:
                after.append((day, d))
            RT.close()
            shift_day(replay)
        check("phone: after FSRS, every card's schedule and history equal Anki's own, every day", not after, after[:1])
    else:
        check("phone: switched FSRS on", False)
    return paths


def simulate_default():
    """Anki's defaults, as in the app (load balancing on): nothing due is ever missed, nothing is lost."""
    print(f"\n=== 1b. The same {DAYS} days with Anki's default settings (load balancing on) ===", flush=True)
    path = os.path.join(WORK, "D.anki2")
    build_base(path, load_balance=True)
    answers = 0
    problems: list = []
    fsrs_day = None
    for day in range(DAYS):
        D = use(path)
        if day not in SKIPPED:
            info = server_day(day)
            answers += sum(len(r) for r in info["rounds"])
            if info["shown"] != info["due"] or info["left_after"] or info["wrong_folder"]:
                problems.append(day)
        if S.fsrs_check()["enabled"] and fsrs_day is None:
            fsrs_day = day
        D.close()
        shift_day(path)
    D = use(path)
    logs = D.db.scalar("select count() from revlog")
    reps_ok = D.db.scalar("select count() from cards c where c.reps != (select count() from revlog r where r.cid = c.id)") == 0
    # a passed review (hard / good / easy on a review card) is due again in 1 day .. 100 years
    bad_ivl = D.db.scalar("select count() from revlog where type = 1 and ease > 1 and (ivl < 1 or ivl > 36500)")
    overdue = D.db.scalar("select count() from cards where queue = 2 and due < ?", D.sched.today)
    print(f"      {answers} answers; FSRS on from day {fsrs_day}", flush=True)
    check("default settings: every day, 'due today' = Anki's queue, all of it studied, folders serve their own cards",
          not problems, problems[:5])
    check("default settings: every answer is in the review history, every card's count matches", logs == answers and reps_ok,
          (logs, answers, reps_ok))
    check("default settings: every passed review got a sane interval (1 day to 100 years)", bad_ivl == 0, bad_ivl)
    check("default settings: no card left overdue", overdue == 0, overdue)
    reviews = S.review_count()
    check("default settings: FSRS on once 900 reviews were reached (off before, unless proven better)",
          fsrs_day is not None if reviews >= S.FSRS_HARD_LIMIT else True, (reviews, fsrs_day))
    D.close()


def recall_check(path: str):
    """The 'chance of remembering' behind the risk bar: with FSRS, Anki's own retrievability for review AND learning
    cards; with the classic scheduler, 90 % when a card (or its learning step) falls due."""
    A = use(path)
    today, cutoff, now = A.sched.today, A.sched.day_cutoff, time.time()
    worst = 0.0
    n = {1: 0, 2: 0, 3: 0}
    for cid, typ, queue, due, ivl, data in A.db.all("select id, type, queue, due, ivl, data from cards where type in (1, 2, 3)"):
        ours = S.recall_now(typ, queue, due, ivl, data, today, now, cutoff)
        anki = A.card_stats_data(cid).fsrs_retrievability
        if ours and ours[1] and anki:
            worst = max(worst, abs(ours[0] - anki))
            n[typ] += 1
    check("risk bar: each card's chance of remembering = Anki's own FSRS retrievability (review and learning cards)",
          n[2] > 0 and worst < 0.01, (n, worst))
    A.close()

    # the classic scheduler: a fresh collection without FSRS
    C = use(os.path.join(WORK, "recall-classic.anki2"))
    S.ensure_limits()
    S.ensure_steps()
    S.ensure_learn_ahead()
    side = {"html": "", "widgets": []}
    card = S.write_note(None, S.ROOT, {"name": "r", "front": side, "back": side})
    C.sched.get_queued_cards()
    S.answer(card.id, 1, 3000)  # "again": back in 10 minutes
    c = C.get_card(card.id)
    data = C.db.scalar("select data from cards where id = ?", c.id)
    lrt = json.loads(data or "{}").get("lrt")
    at = lambda secs: S.recall_now(c.type, c.queue, c.due, c.ivl, data, C.sched.today, lrt + secs, C.sched.day_cutoff)
    step = c.due - lrt
    check("risk bar, classic: Anki keeps the time of the last answer (lrt) for a learning card", bool(lrt) and step > 0,
          (data, step))
    check("risk bar, classic: a learning card is 100 % just answered, 90 % when its step is up, less after",
          at(0)[0] == 1 and abs(at(step)[0] - 0.9) < 0.001 and at(3 * step)[0] < 0.75 and not at(step)[1],
          (at(0), at(step), at(3 * step)))
    rv = S.recall_now(2, 2, C.sched.today, 10, "", C.sched.today, time.time(), C.sched.day_cutoff)
    check("risk bar, classic: a review card on the day it falls due is 90 %", rv == (0.9, False), rv)
    C.close()


def import_limit():
    """Cards from a file: a folder of their own with Anki's daily limit of new cards; folders filled by hand: none."""
    print("\n=== 4. Cards from a file: daily limit of new cards ===", flush=True)
    path = os.path.join(WORK, "import.anki2")
    col = use(path)
    S.ensure_limits()
    S.ensure_steps()
    S.ensure_learn_ahead()
    side = {"html": "", "widgets": []}
    node = S.import_cards(None, "English 50", [{"name": f"w{i}", "front": side, "back": side} for i in range(50)], 10)
    imported = int(node["id"])
    manual = col.decks.add_normal_deck_with_name("دستی").id
    for i in range(30):
        S.write_note(None, manual, {"name": f"m{i}", "front": side, "back": side})
    col.close()
    per_day, problems = [], []
    for day in range(7):
        col = use(path)
        new_before = col.db.scalar("select count() from cards where did = ? and type = 0", imported)
        info = server_day(day)
        per_day.append(new_before - col.db.scalar("select count() from cards where did = ? and type = 0", imported))
        if info["shown"] != info["due"] or info["left_after"]:
            problems.append(day)
        if day == 0:
            manual_new = col.db.scalar("select count() from cards where did = ? and type = 0", manual)
        col.close()
        shift_day(path)
    check("import: 10 new cards a day from the imported folder (50 in 5 days), nothing more", per_day[:6] == [10, 10, 10, 10, 10, 0], per_day)
    check("import: the folder filled by hand is not limited (all 30 new cards on day one)", manual_new == 0, manual_new)
    check("import: every day 'due today' = Anki's queue, all of it studied", not problems, problems)
    col = use(path)
    lim = next(n for n in S.nodes_json() if n["id"] == str(imported))["newLimit"]
    S.set_new_limit(imported, None)
    check("import: the limit is shown and can be removed", lim == 10 and next(n for n in S.nodes_json() if n["id"] == str(imported))["newLimit"] is None)
    col.close()


# ------------------------------------------------------------------ 3: storage


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def http(port: int, path: str, body=None, raw: bytes | None = None, query: str = ""):
    url = f"http://127.0.0.1:{port}{path}{query}"
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"} if raw is None else {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "null")


def storage(paths):
    print("\n=== 3. Storage ===", flush=True)
    # ---- a server killed without warning (power cut, task manager): what it confirmed is on disk
    data = os.path.join(WORK, "crash")
    os.makedirs(data)
    port = free_port()
    proc = subprocess.Popen([sys.executable, "-u", os.path.join(HERE, "server.py")],
                            env={**os.environ, "YADAVAR_DATA": data, "YADAVAR_PORT": str(port)},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                http(port, "/api/fsrs")
                break
            except OSError:
                time.sleep(0.2)
        folder = http(port, "/api/node", {"parentId": None, "name": "پوشه"})
        media = http(port, "/api/media", raw=b"\x89PNG fake picture", query="?name=yadavar.png")["name"]
        w = [{"id": "w1", "kind": "image", "mediaId": media, "x": 1, "y": 2, "w": 30, "h": 40}]
        card = http(port, "/api/card", {"folderId": folder["id"], "name": "کارت", "front": {"html": "", "widgets": w},
                                         "back": {"html": "", "widgets": []}})
        top = http(port, "/api/card", {"folderId": None, "name": "بیرون", "front": {"html": "", "widgets": []},
                                        "back": {"html": "", "widgets": []}})
        http(port, "/api/card/update", {"id": card["id"], "name": "کارت ویرایش‌شده",
                                         "back": {"html": "", "widgets": [{"id": "t", "kind": "text", "mediaId": "", "x": 0,
                                                                           "y": 0, "w": 50, "h": 20, "html": "پاسخ"}]}})
        n = http(port, "/api/next?folder=" + folder["id"])
        http(port, "/api/answer", {"cardId": n["card"]["id"], "rating": 3, "millis": 4000})
        http(port, "/api/settings", {"theme": "light", "fontScale": 1, "newPerDay": 20, "reviewsPerDay": 200,
                                     "retention": 0.88, "recentFonts": ["B Nazanin"]})
        side = {"html": "", "widgets": []}
        imported = http(port, "/api/cards/import", {"parentId": None, "name": "English", "newPerDay": 5,
                                                    "cards": [{"name": f"w{i}", "front": side, "back": side} for i in range(12)]})
    finally:
        # no goodbye: like pulling the plug. A venv's python.exe on Windows only starts the real python as a child, so
        # the whole process tree goes (killing the starter alone left the server running with the collection open)
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
        else:
            proc.kill()
        proc.wait()
    col = Collection(os.path.join(data, "collection.anki2"))
    c1 = col.get_card(int(card["id"]))
    note = c1.note()
    extra = json.loads(note["Extra"])
    check("crash: folder, both cards (in a folder and at the top level) are there",
          col.decks.name(int(folder["id"])) == "پوشه" and col.get_card(int(top["id"])).did == S.ROOT)
    check("crash: the edit (name, back side) is there", note["Name"] == "کارت ویرایش‌شده" and extra["bw"][0]["html"] == "پاسخ")
    check("crash: the answer and its review log are there", c1.reps == 1 and c1.type == 2 and
          col.db.scalar("select count() from revlog where cid = ?", c1.id) == 1)
    check("crash: settings are there", (col.get_config("ankio_settings", {}) or {}).get("recentFonts") == ["B Nazanin"])
    check("crash: cards imported through the app (12, own folder, 5 a day) are there, nothing else replaced",
          col.db.scalar("select count() from cards where did = ?", int(imported["id"])) == 12 and
          col.decks.get(int(imported["id"]))["newLimit"] == 5 and col.decks.name(int(folder["id"])) == "پوشه")
    check("crash: the picture is there", os.path.isfile(os.path.join(col.media.dir(), media)))
    col.close()

    # ---- undo of an answer restores the card exactly (server path)
    A = use(paths["A"])
    cid = A.db.scalar("select id from cards where queue = 2 order by due limit 1")
    before = A.db.first("select type, queue, due, ivl, factor, reps, lapses, left, data from cards where id = ?", cid)
    logs = A.db.scalar("select count() from revlog")
    S.answer(cid, 1, 3000)
    S.undo()
    after = A.db.first("select type, queue, due, ivl, factor, reps, lapses, left, data from cards where id = ?", cid)
    check("undo of an answer restores the card and its history exactly",
          before == after and A.db.scalar("select count() from revlog") == logs, (before, after))

    A.close()

    # ---- a folder whose subfolder has reviews due first: its own cards are answered, and two undos take both back
    N = use(os.path.join(WORK, "nested.anki2"))
    p = N.decks.add_normal_deck_with_name("P").id
    ch = N.decks.add_normal_deck_with_name("P::C").id
    empty = {"html": "", "widgets": []}
    for i in range(3):
        S.write_note(None, ch, {"name": f"sub{i}", "front": empty, "back": empty})
        S.write_note(None, p, {"name": f"own{i}", "front": empty, "back": empty})
    N.db.execute("update cards set type = 2, queue = 2, due = ?, ivl = 3, factor = 2500 where did = ?", N.sched.today, ch)
    first = int(S.next_card(str(p))["card"]["id"])
    S.answer(first, 3, 4000)
    second = int(S.next_card(str(p))["card"]["id"])
    S.answer(second, 1, 4000)
    answered = [N.get_card(c).reps for c in (first, second)] == [1, 1] and N.db.scalar("select count() from revlog") == 2
    S.undo()
    S.undo()
    check("folder with subfolders: its own cards are answered, and undo (twice) takes both answers back",
          answered and [N.get_card(c).reps for c in (first, second)] == [0, 0] and N.db.scalar("select count() from revlog") == 0
          and N.get_card(first).did == p)
    N.close()

    # ---- Anki's own "Check Media" (Anki, AnkiDroid) sees every picture and sound of the cards as used
    M = use(os.path.join(WORK, "media.anki2"))
    pic = M.media.write_data("yadavar.png", b"\x89PNG fake")
    snd = M.media.write_data("yadavar.wav", b"RIFF fake")
    old = M.media.write_data("yadavar_old.png", b"\x89PNG old")
    S.write_note(None, S.ROOT, {"name": "new", "front": {"html": "", "widgets": [{"id": "a", "kind": "image", "mediaId": pic}]},
                                "back": {"html": "", "widgets": [{"id": "b", "kind": "audio", "mediaId": snd}]}})
    legacy = M.new_note(S.notetype)  # a card saved by an earlier version, without the references
    legacy["Name"] = "old"
    legacy["Extra"] = json.dumps({"fw": [{"id": "c", "kind": "image", "mediaId": old}], "bw": []})
    M.add_note(legacy, S.ROOT)
    S.ensure_media_refs()
    unused = list(M.media.check().unused)
    check("Check Media in Anki would keep every picture and sound (new cards and older ones)", unused == [], unused)
    M.close()

    # ---- backup file: everything comes back
    A = use(paths["A"])
    A.media.write_data("yadavar_sound.wav", b"RIFF fake sound")
    pic = A.media.write_data("yadavar_pic.png", b"\x89PNG fake")
    S.write_note(A.db.scalar("select id from cards limit 1"), None,
                 {"front": {"html": "", "widgets": [{"id": "p", "kind": "image", "mediaId": pic, "x": 0, "y": 0, "w": 10, "h": 10}]}})
    A.set_config("ankio_settings", {"theme": "dark", "retention": 0.9, "recentFonts": ["Gulzar"]})
    want = state(A)
    want_ids = A.db.all("select id, cid from revlog order by id")
    want_notes = A.db.all("select id, flds from notes order by id")
    want_decks = sorted(d.name for d in A.decks.all_names_and_ids())
    want_fsrs = A.get_config("ankio_fsrs_check", None)
    want_cfg = A.decks.get_deck_configs_for_update(1)
    want_media = sorted(os.listdir(A.media.dir()))
    S.col = A
    blob = S.export_backup()  # (closes and reopens A)
    A = S.col
    A.close()
    S.col = BOOT
    S.import_backup(blob)  # replaces WORK/boot with the backup
    B = S.col
    got_cfg = B.decks.get_deck_configs_for_update(1)
    check("backup: every card's schedule and history come back", not diff(state(B), want), diff(state(B), want))
    check("backup: review log (with times), notes and folders come back",
          B.db.all("select id, cid from revlog order by id") == want_ids and
          B.db.all("select id, flds from notes order by id") == want_notes and
          sorted(d.name for d in B.decks.all_names_and_ids()) == want_decks)
    check("backup: settings, FSRS state and its parameters come back",
          B.get_config("ankio_settings", None) == {"theme": "dark", "retention": 0.9, "recentFonts": ["Gulzar"]} and
          B.get_config("ankio_fsrs_check", None) == want_fsrs and got_cfg.fsrs == want_cfg.fsrs and
          list(got_cfg.all_config[0].config.config.fsrs_params_6) == list(want_cfg.all_config[0].config.config.fsrs_params_6))
    got_media = sorted(os.listdir(B.media.dir()))
    check("backup: pictures and sounds come back", all(m in got_media for m in want_media) and
          open(os.path.join(B.media.dir(), pic), "rb").read() == b"\x89PNG fake", (want_media, got_media))


def main():
    t0 = time.time()
    paths = simulate()
    recall_check(paths["A"])
    simulate_default()
    import_limit()
    storage(paths)
    if failures:
        print(f"\n{len(failures)} FAILED  ({int(time.time() - t0)} s; the collections are kept in {WORK})")
        sys.exit(1)
    S.col.close()
    shutil.rmtree(WORK, ignore_errors=True)
    print(f"\nALL PASSED  ({int(time.time() - t0)} s)")


if __name__ == "__main__":
    main()
