# systemd — serviços de produção

Retrato do que roda na VPS. Dois processos **separados de propósito**: a sessão
do Baileys é frágil e cara de recuperar (reconectar é o momento de maior risco),
então um erro no bot do Discord não pode derrubá-la.

| serviço | o que faz |
|---|---|
| `doutor-ofertas` | bot do WhatsApp: posta ofertas e reescreve o `groups.json` |
| `doutor-ofertas-discord` | bot do Discord: hoje só o `/funil` |

```bash
systemctl status doutor-ofertas-discord
journalctl -u doutor-ofertas-discord -f
```

Não é aplicado por `npm run deploy` — o script só faz `systemctl restart` do que
já existe. Pra instalar ou alterar uma unit:

```bash
scp deploy/systemd/*.service root@168.231.89.180:/etc/systemd/system/
ssh root@168.231.89.180 'systemctl daemon-reload && systemctl restart doutor-ofertas doutor-ofertas-discord'
```

## Detalhe que já mordeu

`StartLimitBurst` e `StartLimitIntervalSec` pertencem a **`[Unit]`**, não a
`[Service]`. No lugar errado o systemd só avisa `Unknown key ... ignoring` e
segue — o limite de reinício simplesmente não existe, e um serviço em crash-loop
reinicia pra sempre sem ninguém perceber.

O `.env` é lido pelo próprio app (`dotenv/config`), não por `EnvironmentFile`:
o systemd não entende os comentários e aspas daquele arquivo.
