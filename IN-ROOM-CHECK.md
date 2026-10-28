# In-room check: design note (not built yet)

**Problem.** The QR can be photographed and sent to a friend who is not in the room. The
backup PIN now expires on the server, but a QR image shared within its 30-second window
still works. The remaining defence is proving the phone is physically near the lecture.

## Options

| Option | How | Strengths | Weaknesses |
|---|---|---|---|
| **Location (recommended)** | Lecturer's phone records its position when the session starts. A student's check-in sends the phone's position; the server compares distance. | Works on mobile data and Wi-Fi alike; no campus network setup. | Indoor GPS can be 30-100 m off; needs the student to allow location; spoofable on rooted phones. |
| Campus Wi-Fi / IP | Server accepts check-ins only from the campus public IP range. | Cheap, no permission prompt. | Students on mobile data are locked out; a VPN or a friend's hotspot defeats it; needs the IT team's IP list. |
| Bluetooth / NFC beacons | Hardware in each room. | Strongest. | Web apps cannot read Bluetooth beacons passively; cost. |

## Recommended rollout

1. **Flag, do not block.** Send location with every check-in, store distance on the
   attendance row, and raise a fraud-log flag ("checked in 400 m from the lecturer") for the
   Registrar to review. This needs no changes to who can check in, so a bad GPS reading never
   locks a real student out. Run it for a term and look at real distances.
2. **Block only when sure.** After seeing the real distribution, add a per-course or
   per-client setting "require in-room location", with a generous radius (about 150 m) and a
   fallback: if the phone cannot give a location, the student can still check in with the
   lecturer's backup code, and that check-in is flagged.
3. **Privacy.** Location is personal data. Update the consent notice, ask only at check-in,
   keep the coordinates only as long as the fraud review needs, and say so on screen.

## What it touches

- `live_qr_sessions`: add `lecturer_lat`, `lecturer_lng`, `lecturer_accuracy` (set when the
  lecturer starts the session).
- `attendance` (or a side table): `checkin_distance_m`.
- `check_in_to_broadcast()`: accept `p_lat`, `p_lng`, `p_accuracy`; compute distance on the server.
- Student check-in screen: request location, explain why, handle "denied".
- Lecturer start-session: capture position (ask once).
- Fraud centre: new flag type.

Decision needed from you: whether the University is happy with a location prompt at
check-in, and whether phase 1 (flag only) is acceptable.
