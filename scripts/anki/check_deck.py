#!/usr/bin/env python3
"""Anki デッキ（.apkg / .colpkg）の構造を docs/ANKI_DECK_RULES.md に照らして検品する。

    python3 scripts/anki/check_deck.py deck.apkg              # 違反の一覧を表示
    python3 scripts/anki/check_deck.py deck.apkg --fix out.apkg  # 直せるものを直して出力

--fix が書き換えるのはデッキ名とカードの所属デッキだけで、ノートの中身・カードの
スケジュール（次回出題日・間隔・易しさ・回数）・レビュー履歴には一切触れない。
"""
import argparse
import io
import json
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import zipfile
from pathlib import Path

SEP = "\x1f"

# 構造に意味があるため検査の対象外にする教材デッキ
REFERENCE_DECKS = {"LEAP", "シンプル英語構文｜全162文", "英文解釈", "デフォルト", "Default"}

DECK_NAME_RE = re.compile(r"^\d{4}-\d{2}-\d{2} (授業復習|宿題復習)(（.+）)?$")
DATE_PREFIX_RE = re.compile(r"^(?:20)?(\d{2})[-_ ]?(\d{2})[-_ ]?(\d{2})[-_ ]*")


class Deck:
    """1デッキ分。name は "::" 区切りの表示名。"""

    def __init__(self, did, name, cards=0):
        self.did = did
        self.parts = name.split(SEP) if SEP in name else name.split("::")
        self.cards = cards

    @property
    def name(self):
        return "::".join(self.parts)

    @property
    def top(self):
        return self.parts[0]

    @property
    def depth(self):
        return len(self.parts)


def open_collection(path):
    """.apkg / .colpkg を展開し、(sqlite接続, 一時ディレクトリ, 内部ファイル名) を返す。"""
    tmp = Path(tempfile.mkdtemp(prefix="ankicheck-"))
    zf = zipfile.ZipFile(path)
    for member in ("collection.anki21b", "collection.anki21", "collection.anki2"):
        if member in zf.namelist():
            break
    else:
        sys.exit(f"{path}: Anki のコレクションが見つかりません")

    raw = zf.read(member)
    if member.endswith("b"):  # zstd 圧縮
        try:
            import zstandard
        except ImportError:
            sys.exit(
                "この形式を読むには zstandard が必要です:\n"
                "    python3 -m pip install zstandard"
            )
        raw = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)).read()

    db = tmp / "collection.db"
    db.write_bytes(raw)
    con = sqlite3.connect(db)
    con.create_collation(
        "unicase", lambda a, b: (a.lower() > b.lower()) - (a.lower() < b.lower())
    )
    return con, tmp, member


def read_decks(con):
    """新旧どちらのスキーマからもデッキ一覧を読む。"""
    counts = dict(con.execute("select did, count(*) from cards group by did"))
    has_table = con.execute(
        "select 1 from sqlite_master where type='table' and name='decks'"
    ).fetchone()
    if has_table:
        rows = con.execute("select id, name from decks")
    else:  # 旧スキーマ: col.decks に JSON で入っている
        blob = con.execute("select decks from col").fetchone()[0]
        rows = [(int(k), v["name"]) for k, v in json.loads(blob).items()]
    return [Deck(did, name, counts.get(did, 0)) for did, name in rows]


def normalize_date(text):
    """先頭の日付らしき文字列を YYYY-MM-DD に直す。日付がなければ None。"""
    m = DATE_PREFIX_RE.match(text)
    if not m:
        return None, text
    yy, mm, dd = m.groups()
    if not ("01" <= mm <= "12" and "01" <= dd <= "31"):
        return None, text
    return f"20{yy}-{mm}-{dd}", text[m.end():].strip()


def check(decks):
    """規則違反を (レベル, デッキ名, 内容) のリストで返す。"""
    issues = []
    lesson = [d for d in decks if d.top not in REFERENCE_DECKS]
    children = {}
    cards_at = {}
    for d in lesson:
        cards_at[d.name] = cards_at.get(d.name, 0) + d.cards
        for i in range(1, d.depth):
            parent = "::".join(d.parts[:i])
            children.setdefault(parent, set()).add("::".join(d.parts[: i + 1]))

    for d in sorted(lesson, key=lambda x: x.name):
        # 規則3: 階層は2段まで
        if d.depth > 2:
            issues.append(("NG", d.name, f"{d.depth}階層ある（2階層までにする）"))

        # 規則4: 子が1つしかない中間デッキ
        kids = children.get(d.name, set())
        if len(kids) == 1 and not cards_at.get(d.name):
            only = next(iter(kids)).split("::")[-1]
            issues.append(("NG", d.name, f"子が「{only}」1つだけの空の箱（この層を削る）"))

        # 規則4: 親と同じ名前の中間層
        if d.depth >= 2:
            parent_date, parent_rest = normalize_date(d.parts[-2])
            own_date, own_rest = normalize_date(d.parts[-1])
            if own_rest and own_rest == parent_rest:
                issues.append(("NG", d.name, "親と同じ名前の層が挟まっている"))

        # 規則6: サブデッキ名の日付
        if d.depth >= 2:
            date, _ = normalize_date(d.parts[-1])
            if date:
                issues.append(("警告", d.name, "サブデッキ名に日付が入っている（親が持つので不要）"))

        # 規則1: トップレベルの命名
        if d.depth == 1 or d.name == d.top:
            if not DECK_NAME_RE.match(d.top):
                date, rest = normalize_date(d.top)
                if date:
                    issues.append(
                        ("警告", d.top, f"命名が規則外（例: 「{date} 授業復習」の形にする）")
                    )
                else:
                    issues.append(
                        ("警告", d.top, "日付がない（「YYYY-MM-DD 授業復習」の形にする）")
                    )

        # 規則5: 授業と宿題の同居
        if "授業" in d.top and "宿題" in d.top:
            issues.append(("NG", d.top, "授業と宿題が1つのデッキに同居している（分ける）"))

    return issues


def plan_fix(decks):
    """機械的に直せる部分の新しいデッキ名を {旧名: 新名} で返す。"""
    paths = {d.did: list(d.parts) for d in decks if d.top not in REFERENCE_DECKS}
    cards = {d.did: d.cards for d in decks}

    # 子が1つしかない空の層を削る
    while True:
        kids, held = {}, {}
        for did, parts in paths.items():
            key = tuple(parts)
            held[key] = held.get(key, 0) + cards.get(did, 0)
            for i in range(1, len(parts)):
                kids.setdefault(tuple(parts[:i]), set()).add(tuple(parts[: i + 1]))
        for node, ch in kids.items():
            if held.get(node) or len(ch) != 1:
                continue
            depth = len(node)
            # 2つの名前のうち日付を持っている方を残す（規則1: 日付は上位が持つ）
            child_name = next(iter(ch))[-1]
            keep_child = normalize_date(node[-1])[0] is None and normalize_date(child_name)[0]
            for parts in paths.values():
                if tuple(parts[:depth]) != node:
                    continue
                if len(parts) > depth:
                    del parts[depth]
                if keep_child:
                    parts[depth - 1] = child_name
            break
        else:
            break

    for parts in paths.values():
        # トップレベルの日付表記を揃える
        date, rest = normalize_date(parts[0])
        if date:
            parts[0] = f"{date} {rest}".strip()
        # サブデッキ名から日付を落とす
        for i in range(1, len(parts)):
            _, rest = normalize_date(parts[i])
            if rest:
                parts[i] = rest

    return {
        d.name: "::".join(paths[d.did])
        for d in decks
        if d.did in paths and "::".join(paths[d.did]) != d.name
    }


def apply_fix(con, decks, renames):
    """デッキ名と cards.did だけを書き換える。"""
    by_name = {d.name: d for d in decks}
    groups = {}
    for old, new in renames.items():
        groups.setdefault(new, []).append(by_name[old])
    for d in decks:
        if d.name not in renames:
            groups.setdefault(d.name, []).append(d)

    now = int(time.time())
    has_table = con.execute(
        "select 1 from sqlite_master where type='table' and name='decks'"
    ).fetchone()
    if not has_table:
        blob = json.loads(con.execute("select decks from col").fetchone()[0])

    for new_name, members in groups.items():
        keep = max(members, key=lambda d: d.cards)
        for d in members:
            if d is keep:
                continue
            if d.cards:
                con.execute(
                    "update cards set did = ?, mod = ?, usn = -1 where did = ?",
                    (keep.did, now, d.did),
                )
            if has_table:
                con.execute("delete from decks where id = ?", (d.did,))
            else:
                blob.pop(str(d.did), None)
        stored = new_name.replace("::", SEP)
        if has_table:
            con.execute(
                "update decks set name = ?, mtime_secs = ?, usn = -1 where id = ?",
                (stored, now, keep.did),
            )
        else:
            blob[str(keep.did)]["name"] = new_name

    if has_table:  # 中間の層もデッキとして存在させる
        template = con.execute("select common, kind from decks limit 1").fetchone()
        existing = {n for (n,) in con.execute("select name from decks")}
        stamp = int(time.time() * 1000)
        for name in sorted(existing):
            parts = name.split(SEP)
            for i in range(1, len(parts)):
                branch = SEP.join(parts[:i])
                if branch not in existing:
                    stamp += 1
                    con.execute(
                        "insert into decks (id, name, mtime_secs, usn, common, kind)"
                        " values (?,?,?,?,?,?)",
                        (stamp, branch, now, -1, template[0], template[1]),
                    )
                    existing.add(branch)
    else:
        con.execute("update col set decks = ?", (json.dumps(blob),))
    con.execute("update col set mod = ?", (now * 1000,))
    con.commit()


def repack(src, dst, con, tmp, member):
    con.close()
    raw = (tmp / "collection.db").read_bytes()
    if member.endswith("b"):
        import zstandard

        raw = zstandard.ZstdCompressor().compress(raw)
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_STORED) as out:
        for info in zin.infolist():
            data = raw if info.filename == member else zin.read(info.filename)
            out.writestr(info.filename, data, zipfile.ZIP_STORED)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("deck", help=".apkg または .colpkg")
    ap.add_argument("--fix", metavar="OUT", help="直せるものを直して OUT に書き出す")
    args = ap.parse_args()

    con, tmp, member = open_collection(args.deck)
    try:
        decks = read_decks(con)
        lesson = [d for d in decks if d.top not in REFERENCE_DECKS]
        cards = con.execute("select count(*) from cards").fetchone()[0]
        print(f"デッキ {len(decks)}（うち授業・宿題 {len(lesson)}） / カード {cards}")

        issues = check(decks)
        if not issues:
            print("命名規則の違反はありません。")
        else:
            print(f"\n違反 {len(issues)}件:")
            for level, name, msg in issues:
                print(f"  [{level}] {name}\n         {msg}")

        if args.fix:
            renames = plan_fix(decks)
            if not renames:
                print("\n機械的に直せる箇所はありません。")
                return 1 if any(l == "NG" for l, _, _ in issues) else 0
            print(f"\n--- {len(renames)}件のデッキ名を変更 ---")
            for old, new in sorted(renames.items()):
                print(f"  {old}\n    → {new}")
            apply_fix(con, decks, renames)
            repack(args.deck, args.fix, con, tmp, member)
            print(f"\n{args.fix} に書き出しました（学習履歴は未編集）。")
            print("残った警告は内容の判断が必要なので、手で直してください。")
        return 1 if any(l == "NG" for l, _, _ in issues) else 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
