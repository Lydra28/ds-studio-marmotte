/*! Requins : moteur ascii-sharks, repris dans app/client/ocean/.
MIT License

Copyright (c) 2026 drewdi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Requins en fond de la section interactive (lot 2 du site) et du pied de
// page (2026-11-15) : même moteur et mêmes garde-fous que l'accueil de l'app
// (app/client/oceanMount.ts), un moteur par canvas, en pause hors écran. La
// notice MIT ci-dessus est un commentaire légal (/*!) : gardée dans le
// fichier publié, comme l'exige la licence.
import { mountOcean } from '../../../app/client/oceanMount.ts';

// Pied de page : simple décor, figé dès que dessiner prend plus de la moitié
// du temps (demande de Romain du 2026-11-15 : figé si la machine ne suit pas).
document.querySelectorAll<HTMLCanvasElement>('.play-ocean').forEach((canvas) => mountOcean(canvas));
document.querySelectorAll<HTMLCanvasElement>('.foot-ocean').forEach((canvas) => mountOcean(canvas, { maxBusy: 0.5 }));
