"""Diagnostic de la forme de DATABASE_URL, sans jamais afficher son contenu (les logs Actions sont publics)."""
import os, re, urllib.parse

raw = os.environ.get("DATABASE_URL", "")
s = raw.strip()
print("espaces ou retour a la ligne autour :", s != raw)
print("guillemets autour :", s[:1] in "\"'" and s[:1] != "")
print("commence par postgresql:// ou postgres:// :", bool(re.match(r"^postgres(ql)?://", s)))
print("crochets [ ] presents :", "[" in s or "]" in s, "| contient YOUR-PASSWORD :", "YOUR-PASSWORD" in s.upper())
s = s.replace("[", "").replace("]", "")
p = urllib.parse.urlsplit(s.strip("\"'"))
user = p.username or ""
pw = urllib.parse.unquote(p.password or "")
print("utilisateur = postgres.<identifiant du projet> :", bool(re.fullmatch(r"postgres\.[a-z0-9]{20}", user)),
      "| utilisateur = postgres tout court :", user == "postgres")
print("hote pooler :", (p.hostname or "").endswith("pooler.supabase.com"), "| port :", p.port, "| base :", p.path)
print("mot de passe : longueur", len(pw), "| crochets [ ] restants :", "[" in s or "]" in s,
      "| contient YOUR-PASSWORD :", "YOUR-PASSWORD" in s.upper(),
      "| caracteres speciaux bruts @ # / ? :", s.count("@") > 1 or any(c in (p.password or "") for c in "#/?"))
