#!/usr/bin/env python3
"""Generate shift schedule and send to Webex.

Usage:
  python send_shift.py              # today's schedule (morning send)
  python send_shift.py --evening    # next workday preview (evening send)

Env vars: WEBEX_TOKEN, WEBEX_ROOM_ID
"""

import json
import os
import random
import sys
from datetime import date, timedelta
from pathlib import Path
import urllib.request

SCHEDULER_URL = "https://ymatz28-beep.github.io/shift-scheduler/"
DATA_FILE = Path(__file__).resolve().parents[2] / "data" / "shifts.json"


def load_data():
    with open(DATA_FILE) as f:
        return json.load(f)


def is_weekday(d: date) -> bool:
    return d.weekday() < 5


def next_workday(d: date) -> date:
    nxt = d + timedelta(days=1)
    while not is_weekday(nxt):
        nxt += timedelta(days=1)
    return nxt


def get_status(data: dict, member: str, date_str: str) -> str:
    return data.get("availability", {}).get(member, {}).get(date_str, "available")


def generate_schedule(data: dict, target: date) -> dict:
    date_str = target.isoformat()
    members = data["team_members"]
    time_slots = data["time_slots"]
    late_slots = data.get("late_shift_slots", [])

    # Categorize members by status
    late_shift_members = []
    regular_members = []
    for m in members:
        status = get_status(data, m, date_str)
        if status in ("pto", "exclude"):
            continue
        if status == "late-shift":
            late_shift_members.append(m)
        else:
            regular_members.append(m)

    all_available = regular_members + late_shift_members
    if len(all_available) < 1:
        return {"error": "Not enough members"}

    schedule = {}

    # 1. Late-shift slots: ONLY late-shift members
    late_slot_list = [s for s in time_slots if s in late_slots]
    regular_slot_list = [s for s in time_slots if s not in late_slots]

    if late_slot_list and late_shift_members:
        shuffled_late = late_shift_members[:]
        random.shuffle(shuffled_late)
        for i, slot in enumerate(late_slot_list):
            schedule[slot] = [shuffled_late[i % len(shuffled_late)]]
    elif late_slot_list:
        # No late-shift members: include these slots in regular round-robin
        regular_slot_list = [s for s in time_slots if s not in schedule]

    # 2. Round-robin for regular slots (only regular members)
    pool = regular_members if regular_members else all_available
    random.shuffle(pool)
    slots_to_fill = [s for s in time_slots if s not in schedule]
    for i, slot in enumerate(slots_to_fill):
        schedule[slot] = [pool[i % len(pool)]]

    return schedule


def format_message(data: dict, target: date, schedule: dict, is_evening: bool = False) -> str:
    date_str = target.isoformat()
    members = data["team_members"]
    weekdays_ja = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    day_label = weekdays_ja[target.weekday()]
    date_display = f"{target.year}/{target.month:02d}/{target.day:02d} ({day_label})"

    lines = []
    if is_evening:
        lines.append(f"📅 Tomorrow's Preview\n")
    lines.append(f"📞 Phone Shift Schedule — {date_display}")
    lines.append("━━━━━━━━━━━━━━━━━━━━━━━")

    for slot in data["time_slots"]:
        people = schedule.get(slot, [])
        lines.append(f"  {slot}  →  {' · '.join(people)}")

    lines.append("━━━━━━━━━━━━━━━━━━━━━━━")

    late_members = [m for m in members if get_status(data, m, date_str) == "late-shift"]
    pto_members = [m for m in members if get_status(data, m, date_str) == "pto"]

    if late_members:
        lines.append(f"🕐 Late shift: {', '.join(late_members)}")
    if pto_members:
        lines.append(f"🌴 PTO: {', '.join(pto_members)}")

    lines.append(f"\nHave a great day! 🙌")
    lines.append(f"📋 {SCHEDULER_URL}")

    return "\n".join(lines)


def send_webex(message: str):
    token = os.environ.get("WEBEX_TOKEN")
    room_id = os.environ.get("WEBEX_ROOM_ID")

    if not token or not room_id:
        print("ERROR: WEBEX_TOKEN and WEBEX_ROOM_ID must be set")
        sys.exit(1)

    payload = json.dumps({"roomId": room_id, "markdown": message}).encode()
    req = urllib.request.Request(
        "https://webexapis.com/v1/messages",
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    with urllib.request.urlopen(req) as resp:
        if resp.status == 200:
            print(f"Sent successfully (HTTP {resp.status})")
        else:
            print(f"Failed: HTTP {resp.status}")
            sys.exit(1)


def main():
    is_evening = "--evening" in sys.argv
    data = load_data()
    today = date.today()

    if is_evening:
        target = next_workday(today)
    else:
        target = today

    if not is_weekday(target):
        print(f"Skipping: {target} is not a weekday")
        return

    schedule = generate_schedule(data, target)
    if "error" in schedule:
        print(f"ERROR: {schedule['error']}")
        sys.exit(1)

    message = format_message(data, target, schedule, is_evening)
    print(message)
    print("---")
    send_webex(message)


if __name__ == "__main__":
    main()
