// One place mapping item kinds (and their vehicle-type variants) to lucide
// icons, replacing the raw emoji previously scattered across cards. Lucide
// icons render as inline SVG with stroke = currentColor, so they pick up the
// per-kind CSS variables and every theme automatically — unlike emoji, which
// ignore color and render differently per OS.
import {
  Plane, TrainFront, BedDouble, UtensilsCrossed, Star, Footprints, Bike,
  CarFront, Bus, CarTaxiFront, Ship, Sailboat, Ticket, Utensils, ShoppingBag,
  StickyNote, Theater, Truck,
} from 'lucide-react'

const KIND_ICON = {
  flight:         Plane,
  rail:           TrainFront,
  accommodation:  BedDouble,
  restaurant:     UtensilsCrossed,
  activity:       Star,
  walk:           Footprints,
  cycling:        Bike,
  transfer:       CarFront,
  river_transfer: Ship,
  tour:           Ticket,
  food:           Utensils,
  purchase:       ShoppingBag,
  note:           StickyNote,
  show:           Theater,
  hire:           CarFront,
}

// vehicle_type refinements per kind (lowercased key). Types without a close
// lucide equivalent (scooter, motorcycle) fall back to Bike/CarFront rather
// than stretching a wrong metaphor.
const VEHICLE_ICON = {
  transfer:       { bus: Bus, minibus: Bus, shuttle: Bus, taxi: CarTaxiFront },
  river_transfer: { ferry: Ship, boat: Sailboat, riverboat: Sailboat, 'water taxi': Sailboat },
  hire:           { car: CarFront, bike: Bike, scooter: Bike, van: Truck, motorcycle: Bike },
}

export function iconForItem(kind, details) {
  const vt = (details?.vehicle_type || '').toLowerCase()
  return VEHICLE_ICON[kind]?.[vt] ?? KIND_ICON[kind] ?? StickyNote
}

/** Inline kind icon, sized to sit in card/text rows. Decorative — the
 * surrounding element carries the accessible label/title. */
export function KindIcon({ kind, details, size = 15, ...props }) {
  const Icon = iconForItem(kind, details)
  return <Icon size={size} strokeWidth={2.25} aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em' }} {...props} />
}
