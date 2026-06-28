# TCG Radar — pipeline dati

Genera il file `data.json` che l'app TCG Radar legge (prezzi + notizie).

## Come funziona
1. `watchlist.json` → l'elenco delle carte da seguire (modificabile a mano).
2. `build_data.py` → recupera i prezzi, aggiorna lo storico, scrive `data.json`.
3. `history.json` → storico prezzi (creato in automatico, serve per i grafici e il +/- 7g).
4. `data.json` → l'output finale (questo va pubblicato online e collegato all'app).

## Avvio rapido (modalità DEMO, senza chiavi)
```
py build_data.py --demo
```
Crea un `data.json` con prezzi finti ma realistici: serve per provare la struttura.

## Dati REALI (eBay USA)
1. Crea un account gratis su https://developer.ebay.com
2. "Application Keysets" → crea un keyset **Production** → copia **App ID** e **Cert ID**.
3. Copia `.env.example` in `.env` e incolla le due chiavi.
4. Installa la libreria una volta sola:
   ```
   py -m pip install -r requirements.txt
   ```
5. Lancia:
   ```
   py build_data.py
   ```

## Note oneste
- eBay Browse API dà i prezzi degli annunci **attivi** (richiesti), non i venduti reali:
  è una buona stima, leggermente più alta del prezzo reale di vendita.
- Lo storico (`+/- 7g` e i grafici) si riempie col tempo: i primi giorni sarà piatto.
- Aggiornamento sensato: ogni poche ore, non "al minuto" (il mercato carte non si muove così).

## Prossime fasi
- Fase 2: notizie automatiche via RSS.
- Fase 3: segnale "hype" da Reddit.
- Fase 4: mercati Europa (Cardmarket) e Giappone.
