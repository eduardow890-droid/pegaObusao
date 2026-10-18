# Ônibus do Rio ao vivo

Mapa com a posição em tempo real dos ônibus do Rio, 100% gratuito:
dados abertos da Prefeitura + OpenStreetMap + MapLibre. Sem dependências no backend.

## Como rodar

1. Instale o Node.js 18 ou mais novo (nodejs.org).
2. Na pasta do projeto, rode:

   ```
   node server.js
   ```

3. Abra http://localhost:3001, digite uma linha (ex.: 485) e clique em Ver.

Para executar os testes automatizados, rode `npm test`.

## API usada

A API antiga (`dados.mobilidade.rio/gps/sppo`) foi descontinuada e será desligada até 30/11/2026.
Este projeto usa a nova API da SMTR: `https://its.mobilidade.rio/v1/geolocalizacao/veiculos`
(documentação em https://its.mobilidade.rio/docs).

Ela trabalha com minutos UTC (`minuto_utc`), aceita filtro por `servico` (a linha) e devolve
`next_cursor` quando há mais páginas. O `lib.js` consulta o minuto atual e o anterior, segue as páginas
e fica com a posição mais recente de cada ônibus. A resposta da aplicação é normalizada para o contrato
`{ linha, total, atualizadoEm, onibus }`, consumido pelo mapa em `public/index.html`.

Se a API mudar seu contrato, a validação em `lib.js` falha com erro em vez de tratar uma resposta inválida
como se não houvesse ônibus. A paginação também falha explicitamente se ultrapassar o limite de segurança.

Para trocar o endereço sem mexer no código:

```
GPS_URL="https://endereco-atual" node server.js
```

## Estrutura

- `lib.js`: acesso à API da SMTR (minuto UTC, paginação, timeout, validação)
- `server.js`: cache limitado a 100 linhas por 15 s, coalescência de consultas simultâneas e rota `/api/onibus?linha=XXX`
- `test/`: testes automatizados (`npm test`) e exemplos de resposta em `test/fixtures/`
- `public/index.html`: mapa e busca de linha

## Próximos passos

1. Paradas e horários: importar o GTFS do Rio.
2. Planejador de rotas A até B: OpenTripPlanner (GTFS + OSM) hospedado no Oracle Cloud Free Tier.
3. Busca de endereços: Nominatim ou Photon.
4. Transformar em PWA (manifest + service worker) para instalar no celular sem loja.

Observação: os tiles públicos do OpenStreetMap servem para testes e uso leve.
Se o app crescer, use um provedor de tiles próprio ou gratuito com cota (ex.: MapTiler).
