# Fish Logger

Logboek voor vissessies (snoek, snoekbaars, baars met kunstaas; forel, kopvoorn, ruisvoorn en winde met de vlieg). Het doel is patronen te ontdekken: onder welke omstandigheden vang je het meest per uur?

## Release 1

- Sessie starten en stoppen: tijd, GPS-locatie, weer (Open-Meteo), luchtdruk en drukverloop, dagdeel, seizoen en maanfase worden automatisch vastgelegd. Ook sessies zonder vangst worden opgeslagen.
- Stekken op een satellietkaart, met een versleepbare pin en de GPS-nauwkeurigheid in meters.
- Methode, kunstaas, waterhelderheid en visplek (kant, wadend, boot) kies je met één tik.
- Vangsten met soort, lengte (cm), tijd, aas, methode en foto.
- Tackle box met je eigen kunstaas en methodes.
- Logboek met vangst per uur, export naar Excel (CSV) en back-up / terugzetten.

## Techniek

Een statische web-app (HTML, CSS en JavaScript, geen build-stap) die je via Safari op het beginscherm van je iPhone zet.

- Gegevens en foto's staan op het toestel zelf (IndexedDB). Maak regelmatig een back-up via Logboek › Maak back-up.
- Weer: [Open-Meteo](https://open-meteo.com), gratis en zonder account. Zonder bereik wordt het weer later aangevuld.
- Kaart: [Leaflet](https://leafletjs.com) (meegeleverd in `vendor/`), satellietbeelden van Esri en kaarten van OpenStreetMap.
- Een service worker zorgt dat de app ook zonder bereik opent.

## Publiceren met GitHub Pages

Settings › Pages › Deploy from a branch › `main` / `(root)`. De app staat daarna op `https://<gebruikersnaam>.github.io/fish-logger/`.
