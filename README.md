# Cortevo NFS-e Gateway

Serviço que conecta o **Cortevo Barber** ao **Emissor Nacional da NFS-e**
(`nfse.gov.br` / SefinNacional, padrão nacional). Ele existe por um motivo
técnico simples: a emissão exige **TLS com certificado de cliente (A1)** e o
runtime de funções do Base44 não consegue abrir esse tipo de conexão. O
gateway guarda o `.pfx` de cada barbearia e assina a requisição.

```
Cortevo (Base44)  ──x-api-key──►  este gateway  ──mTLS A1──►  sefin.nfse.gov.br
```

## O que ele faz

| Rota | Função |
|---|---|
| `GET /health` | status, ambiente e quantidade de certificados |
| `POST /certificado` | recebe `.pfx` + senha, valida e guarda por tenant |
| `DELETE /certificado/:ref` | remove o certificado do tenant |
| `POST /nfse/emitir` | monta a DPS e emite a NFS-e |
| `GET /nfse/status?chave=` | consulta a nota pela chave |
| `GET /dps/:id` | consulta a DPS pelo id |
| `POST /nfse/cancelar` | evento de cancelamento com motivo |
| `GET /parametros/:municipio` | alíquotas e códigos de tributo do município |

Todas as rotas (menos `/health`) exigem o header `x-api-key`.

## Modo sem custo (sem disco, sem volume)

Com `GATEWAY_STATELESS=1` o gateway **não guarda certificado em disco**. O app
envia o `.pfx` e a senha no corpo de cada chamada e o gateway usa apenas em
memória. Assim ele roda no **plano grátis do Render** (que não tem disco
persistente) sem perder nada em restart.

O que muda no app: a Nfse/ShopFiscal guarda o `.pfx` em storage privado e
`nfseIssue` manda `pfx_base64` + `senha` junto com os dados da nota.

Trade-off honesto: o certificado trafega a cada emissão (sempre por HTTPS) e
fica no storage do app em vez de só no servidor. Mitigação: guardar o `.pfx`
privado, nunca em log, e poder revogar/trocar o certificado a qualquer momento.

## Deploy rápido (Railway, Render, Fly.io ou VPS)

```bash
docker build -t cortevo-nfse-gateway .
docker run -d --name nfse-gateway \
  -p 8080:8080 \
  -e GATEWAY_API_KEY="sua-chave-forte" \
  -e NFSE_AMBIENTE="restrita" \
  -v /srv/cortevo/certs:/data/certs \
  cortevo-nfse-gateway
```

Sem Docker:

```bash
npm install
cp .env.example .env   # ajuste os valores
node server.js
```

## Ligando no app

No Cortevo, cadastre os secrets:

- `NFSE_GATEWAY_URL` → `https://seu-gateway.exemplo.com`
- `NFSE_GATEWAY_KEY` → a mesma `GATEWAY_API_KEY`

Depois, na tela de configuração fiscal, envie o `.pfx` A1 e a senha. O app
manda para cá, este serviço valida, e devolve titular, CNPJ e validade. O app
guarda só esses dados, nunca o arquivo nem a senha.

## Padrão dos dados que o app envia em `/nfse/emitir`

```json
{
  "cert_ref": "6aed114e24de871571f42200",
  "municipio_ibge": "3167202",
  "serie": "1",
  "numero": "1",
  "competencia": "2026-11-06",
  "prestador": {
    "cnpj": "62978287000186",
    "inscricao_municipal": "123456",
    "razao_social": "BARBEARIA EXEMPLO LTDA",
    "email": "contato@exemplo.com"
  },
  "tomador": {
    "doc": "12345678909",
    "nome": "Cliente Exemplo",
    "email": "cliente@exemplo.com"
  },
  "servico": {
    "codigo_trib_nacional": "060101",
    "descricao": "Corte de cabelo masculino",
    "codigo_nbs": "123456789"
  },
  "valores": { "total_centavos": 4500, "iss_aliquota": 2, "iss_retido": false }
}
```

## Antes de ir para produção

1. Teste primeiro com `NFSE_AMBIENTE=restrita` (ambiente de produção restrita).
2. Confirme no Emissor Nacional que a barbearia está **habilitada** a emitir
   (inscrição municipal ativa e, em muitos municípios, credenciamento).
3. Rode `GET /parametros/:municipio` para ver a alíquota e os códigos de
   tributo aceitos por Sete Lagoas antes de emitir de verdade.
4. Os códigos de tributação padrão aqui são `060101` (barbearia/cabeleireiro,
   item 6.01 da LC 116). Ajuste se o contador indicar outro enquadramento.
5. Guarde o disco de certificados com permissão restrita e backup cifrado.
   Aqui os arquivos já são gravados com modo `0600`.

## Avisos honestos

- A NFS-e Nacional **não envia webhook**. O status é obtido por consulta
  (`GET /nfse/status` ou `GET /dps/:id`). O app faz reconciliação por polling.
- As bases oficiais usadas são `sefin.nfse.gov.br/SefinNacional` (produção) e
  `sefin.producaorestrita.nfse.gov.br/SefinNacional` (homologação). Se a Sefin
  mudar o caminho, ajuste por `NFSE_BASE_URL` sem mexer no código.
- O layout da DPS segue o padrão nacional v1.00. Campos que o seu município
  exigir a mais entram em `servico`/`valores` no `buildInfDPS`.
