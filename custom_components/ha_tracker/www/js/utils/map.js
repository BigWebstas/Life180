import { USE_MAP } from '../globals.js';

let _implPromise;
function _getImpl() {
  if (!_implPromise) {
    _implPromise = USE_MAP === '2D'
      ? import('./map2D.js')
      : import('./map3D.js');
  }
  return _implPromise;
}

export let map; // <- se asigna tras initMap()

export async function initMap(...args) {
  const m = await _getImpl();
  const result = await m.initMap(...args);
  // OJO: aquí actualizamos el export para que deje de ser undefined
  map = m.map;
  return result;
}

// Si prefieres, un helper para obtener el mapa asegurado:
export async function getMap() {
  const m = await _getImpl();
  if (!m.map) {
    // si aún no se llamó a initMap, la llamamos sin args
    await m.initMap?.();
  }
  map = m.map;
  return map;
}

// utilidades síncronas (idénticas en 2D/3D)
export function isValidCoordinates(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng);
}
export function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = d => d*Math.PI/180;
  const dLat = toR(lat2-lat1), dLon = toR(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1))*Math.cos(toR(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
