"""Test ElevenLabs + Firecrawl : affiche seulement des compteurs et des statuts (journaux publics)."""
import json, os, urllib.request


def call(url, key_header, key, body=None, method=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, method=method,
                                 headers={key_header: key, "Content-Type": "application/json", "User-Agent": "delay-recorder"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


print("== ElevenLabs")
k = os.environ.get("ELEVENLABS_API_KEY", "")
st, b = call("https://api.elevenlabs.io/v1/user/subscription", "xi-api-key", k)
if st == 200:
    s = json.loads(b); print(f"  offre {s.get('tier')} : {s.get('character_count')}/{s.get('character_limit')} caracteres utilises ce mois")
else:
    print("  abonnement :", st, b[:150])
st, b = call("https://api.elevenlabs.io/v1/voices", "xi-api-key", k)
voices = json.loads(b).get("voices", []) if st == 200 else []
print(f"  voix disponibles : {len(voices)} ({st})", [v.get("name") for v in voices[:8]])
vid = next((v["voice_id"] for v in voices if v.get("category") == "premade"), voices[0]["voice_id"] if voices else "JBFqnCBsd6RMkjVDRZzb")
text = "Ton TER de 8 heures 12 a 27 minutes de retard. 1 euro 13 ont été ajoutés à ton mois, et ton justificatif est parti chez ton employeur."
st, audio = call(f"https://api.elevenlabs.io/v1/text-to-speech/{vid}?output_format=mp3_44100_128", "xi-api-key", k,
                 {"text": text, "model_id": "eleven_multilingual_v2"})
if st == 200 and audio[:3] in (b"ID3", b"\xff\xfb", b"\xff\xf3"):
    os.makedirs("out", exist_ok=True); open("out/alerte_fr.mp3", "wb").write(audio)
    print(f"  MP3 genere : {len(audio)/1e3:.0f} ko pour {len(text)} caracteres -> OK")
else:
    print("  synthese vocale :", st, audio[:200])

print("== Firecrawl")
k = os.environ.get("FIRECRAWL_API_KEY", "")
for url in ("https://www.sncf-voyageurs.com/fr/voyagez-avec-nous/horaires-et-infos-trafic/",
            "https://www.ter.sncf.com/auvergne-rhone-alpes/se-deplacer/info-trafic"):
    st, b = call("https://api.firecrawl.dev/v1/scrape", "Authorization", f"Bearer {k}",
                 {"url": url, "formats": ["markdown"], "onlyMainContent": True})
    if st == 200:
        d = json.loads(b).get("data", {}); md = d.get("markdown") or ""
        low = md.lower()
        print(f"  {url.split('/')[2]} : {len(md)} caracteres ; mots-cles : retard={low.count('retard')}, "
              f"supprim={low.count('supprim')}, travaux={low.count('travaux')}, greve={low.count('grève')+low.count('greve')}")
    else:
        print(f"  {url.split('/')[2]} :", st, b[:200])
st, b = call("https://api.firecrawl.dev/v1/team/credit-usage", "Authorization", f"Bearer {k}")
print("  credits restants :", json.loads(b).get("data", {}).get("remaining_credits") if st == 200 else (st, b[:120]))
