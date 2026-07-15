#!/bin/bash
# Túnel SSH persistente saves-backend -> NBI de GenieACS (remoto localhost:7557).
# Reenvía el puerto local 17557 al NBI. Gestionado por PM2 (reinicia si cae).
# Auth por llave dedicada (~/.ssh/genieacs_tunnel), sin contraseña.
exec ssh -N \
  -i "$HOME/.ssh/genieacs_tunnel" \
  -p 2222 \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 17557:localhost:7557 \
  paginasvestel@localhost
