#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
流动的书 · 每日复习提醒

直接读取本地 SQLite（data/reading.db），不依赖服务是否启动。
输出一段中文摘要，供自动化任务在每天固定时间推送给用户。

用法：
    python3 remind.py
"""
import os
import sys
import sqlite3
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "data", "reading.db")
TODAY = datetime.date.today()

# 卡片池的定义需与 server.js 中的 POOL_WHERE 保持一致
POOL_WHERE = "h.source IN ('my','manual') AND LENGTH(h.mark_text) BETWEEN 12 AND 320"


def iso(d):
    return d.isoformat()


def streak(cur, today):
    rows = [r[0] for r in cur.execute("SELECT day FROM checkin ORDER BY day DESC LIMIT 400")]
    if not rows:
        return 0, False
    s = set(rows)
    cursor = today
    if iso(cursor) not in s:
        cursor -= datetime.timedelta(days=1)
    n = 0
    while iso(cursor) in s:
        n += 1
        cursor -= datetime.timedelta(days=1)
    return n, iso(today) in s


def clip(text, n=90):
    t = " ".join(str(text or "").split())
    return t if len(t) <= n else t[:n] + "…"


def main():
    if not os.path.exists(DB):
        print("ERROR: 还没有本地数据库 %s，先在「流动的书」里同步一次微信读书。" % DB)
        return 1

    con = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
    cur = con.cursor()

    today_s = iso(TODAY)
    total = cur.execute("SELECT COUNT(*) FROM highlights h WHERE %s" % POOL_WHERE).fetchone()[0]
    reviewed = cur.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]
    mastered = cur.execute("SELECT COUNT(*) FROM reviews WHERE stage>=4").fetchone()[0]
    done_today = cur.execute("SELECT COUNT(*) FROM review_log WHERE day=?", (today_s,)).fetchone()[0]
    sk, checked = streak(cur, TODAY)

    due = cur.execute(
        """
        SELECT h.id, h.mark_text, b.title, b.author, r.due_date, r.stage, r.review_count
        FROM reviews r
        JOIN highlights h ON h.id = r.target_id
        LEFT JOIN books b ON b.book_id = h.book_id
        WHERE r.due_date <= ?
        ORDER BY r.due_date, r.review_count DESC
        LIMIT 5
        """,
        (today_s,),
    ).fetchall()
    due_total = cur.execute("SELECT COUNT(*) FROM reviews WHERE due_date<=?", (today_s,)).fetchone()[0]

    print("DATE %s" % today_s)
    print("DUE %d" % due_total)
    print("TOTAL %d" % total)
    print("REVIEWED %d" % reviewed)
    print("MASTERED %d" % mastered)
    print("DONE_TODAY %d" % done_today)
    print("STREAK %d" % sk)
    print("CHECKED_IN %s" % ("yes" if checked else "no"))

    if due_total:
        print("")
        print("## 今天到期，该复习了")
        for i, (hid, text, title, author, dd, stage, cnt) in enumerate(due, 1):
            print("%d. 《%s》%s" % (i, title or "未知", ("· " + author) if author else ""))
            print("   “%s”" % clip(text))
            print("   上次复习：%s ｜ 已复习 %d 次" % (dd, cnt))
            # 带上卡片 id，方便脚本调用方给出跳转
            print("   [card:%d]" % hid)
    else:
        print("")
        print("## 今天没有到期卡片，从还没复习过的里挑几张")
        fresh = cur.execute(
            """
            SELECT h.id, h.mark_text, b.title, b.author
            FROM highlights h
            LEFT JOIN books b ON b.book_id = h.book_id
            WHERE %s
              AND h.id NOT IN (SELECT target_id FROM reviews)
            ORDER BY RANDOM() LIMIT 3
            """ % POOL_WHERE,
        ).fetchall()
        if not fresh:
            print("（卡片池里的卡片都复习过了，或者在「卡片库」里看看。）")
        for i, (hid, text, title, author) in enumerate(fresh, 1):
            print("%d. 《%s》%s" % (i, title or "未知", ("· " + author) if author else ""))
            print("   “%s”" % clip(text))
            print("   [card:%d]" % hid)

    if not checked:
        print("")
        print("（今天还没打卡。）")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
