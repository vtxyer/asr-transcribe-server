#!/usr/bin/env bash
# Locate Muse-for-macOS credentials in the login keychain.
#
# The desktop build keeps its FRL + ABRA session in EndoAuth.KeychainCredentialStore
# ("[TokenStorage] Keychain", "[Auth][CredentialStore] ..."), and sends the ABRA
# access token in the Voyager handshake as authorization.accessToken.
#
# Usage:
#   ./dump-desktop-creds.sh            # list matching service/account pairs (no secrets)
#   ./dump-desktop-creds.sh --show     # also print the stored secret (keychain may prompt)
#
# Run it yourself, on your own Mac, after signing into the app.

set -euo pipefail

SHOW=0
[[ "${1:-}" == "--show" ]] && SHOW=1

echo "== keychain items matching endo / muse / meta / abra =="
security dump-keychain 2>/dev/null \
  | grep -iE '"svce"|"acct"|class:|"desc"' \
  | grep -iE 'endo|muse|meta|abra|frl' -B2 \
  | sed 's/^[[:space:]]*//' \
  | sort -u || true

echo
echo "== generic passwords (service + account) =="
PAIRS=$(security dump-keychain 2>/dev/null \
  | awk '
      /"svce"<blob>=/ { svce=$0; sub(/.*"svce"<blob>=/,"",svce); gsub(/^"|"$/,"",svce) }
      /"acct"<blob>=/ { acct=$0; sub(/.*"acct"<blob>=/,"",acct); gsub(/^"|"$/,"",acct);
                        if (svce ~ /endo|muse|meta|abra/) print svce "\t" acct }
    ' | sort -u)

if [[ -z "$PAIRS" ]]; then
  echo "(none found — is Muse for macOS installed and logged in?)"
  exit 0
fi

printf '%s\n' "$PAIRS" | while IFS=$'\t' read -r svce acct; do
  echo "- service=$svce account=$acct"
  if [[ $SHOW -eq 1 ]]; then
    security find-generic-password -s "$svce" -a "$acct" -w 2>/dev/null \
      | head -c 400; echo
  fi
done

cat <<'EOF'

Next step: the secret is usually a JSON blob. Find the access token in it, e.g.

  ./dump-desktop-creds.sh --show | grep -o '"accessToken":"[^"]*"'

then:

  mkdir -p ~/.config/muse-voice && chmod 700 ~/.config/muse-voice
  printf '%s' '<token>' > ~/.config/muse-voice/token && chmod 600 ~/.config/muse-voice/token

If the keychain entry is protected, open Keychain Access.app, search "endo"/"Muse",
and use "Show password" after authenticating.
EOF
