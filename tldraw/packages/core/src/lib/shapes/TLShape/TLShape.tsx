/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  intersectLineSegmentBounds,
  intersectLineSegmentPolyline,
  intersectPolygonBounds,
  intersectRayBounds,
} from '@tldraw/intersect'
import Vec from '@tldraw/vec'
import { action, computed, makeObservable, observable, toJS } from 'mobx'
import { BINDING_DISTANCE } from '~constants'
import type { TLAsset, TLBounds, TLHandle, TLResizeCorner, TLResizeEdge } from '~types'
import { BoundsUtils, deepCopy, PointUtils } from '~utils'

export type TLShapeModel<P extends TLShapeProps = TLShapeProps> = {
  nonce?: number
} & Partial<P> & { id: string; type: P['type'] }

export interface TLShapeConstructor<S extends TLShape = TLShape> {
  new (props: any): S
  id: string
  smart: boolean
}

export type TLFlag = boolean

export interface TLShapeProps {
  id: string
  type: any
  parentId: string
  name?: string
  point: number[]
  scale?: number[]
  rotation?: number
  handles?: Record<string, TLHandle>
  clipping?: number | number[]
  assetId?: string
  children?: string[]
  isGhost?: boolean
  isHidden?: boolean
  isLocked?: boolean
  isGenerated?: boolean
  isSizeLocked?: boolean
  isAspectRatioLocked?: boolean
  logseqLink?: string
}

export interface TLResizeStartInfo {
  isSingle: boolean
}

export interface TLResizeInfo {
  bounds: TLBounds
  center: number[]
  rotation: number
  type: TLResizeEdge | TLResizeCorner
  clip: boolean
  scale: number[]
  transformOrigin: number[]
}

export interface TLResetBoundsInfo<T extends TLAsset> {
  asset?: T
}

export interface TLHandleChangeInfo {
  id: string
  delta: number[]
}

export abstract class TLShape<P extends TLShapeProps = TLShapeProps, M = any> {
  constructor(props: Partial<P>) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const type = this.constructor['id']
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const defaultProps = this.constructor['defaultProps'] ?? {}
    this.type = type
    this.props = { scale: [1, 1], ...defaultProps, ...props }
    makeObservable(this)
  }

  // there should be only one Shape that is smart (created by double click canvas)
  static smart: boolean
  static type: string

  @observable props: P
  aspectRatio?: number
  type: string
  // Display options
  hideCloneHandles = false
  hideResizeHandles = false
  hideRotateHandle = false
  hideContextBar = false
  hideSelectionDetail = false
  hideSelection = false
  // Behavior options
  canChangeAspectRatio: TLFlag = true
  canUnmount: TLFlag = true
  canResize: [TLFlag, TLFlag] = [true, true]
  canScale: TLFlag = true
  canFlip: TLFlag = true
  canEdit: TLFlag = false
  canBind: TLFlag = false
  canActivate: TLFlag = false
  nonce = 0

  bindingDistance = BINDING_DISTANCE

  // For smart shape
  @observable private _draft = false
  @observable private isDirty = false
  @observable private lastSerialized: TLShapeModel<P> | undefined

  abstract getBounds: () => TLBounds

  @computed get id() {
    return this.props.id
  }

  @computed
  get draft() {
    return this._draft
  }

  @action setDraft(draft: boolean) {
    this._draft = draft
  }

  @action setIsDirty(isDirty: boolean) {
    this.isDirty = isDirty
  }

  @action setLastSerialized(serialized: TLShapeModel<P>) {
    this.lastSerialized = serialized
  }

  getCenter = () => {
    return BoundsUtils.getBoundsCenter(this.bounds)
  }

  getRotatedBounds = () => {
    const {
      bounds,
      props: { rotation },
    } = this
    if (!rotation) return bounds
    return BoundsUtils.getBoundsFromPoints(BoundsUtils.getRotatedCorners(bounds, rotation))
  }

  hitTestPoint = (point: number[]): boolean => {
    const ownBounds = this.rotatedBounds
    if (!this.props.rotation) {
      return PointUtils.pointInBounds(point, ownBounds)
    }
    const corners = BoundsUtils.getRotatedCorners(ownBounds, this.props.rotation)
    return PointUtils.pointInPolygon(point, corners)
  }

  hitTestLineSegment = (A: number[], B: number[]): boolean => {
    const box = BoundsUtils.getBoundsFromPoints([A, B])
    const {
      rotatedBounds,
      props: { rotation = 0 },
    } = this
    return BoundsUtils.boundsContain(rotatedBounds, box) || rotation
      ? intersectLineSegmentPolyline(A, B, BoundsUtils.getRotatedCorners(this.bounds)).didIntersect
      : intersectLineSegmentBounds(A, B, rotatedBounds).length > 0
  }

  hitTestBounds = (bounds: TLBounds): boolean => {
    const {
      rotatedBounds,
      props: { rotation = 0 },
    } = this
    const corners = BoundsUtils.getRotatedCorners(this.bounds, rotation)
    return (
      BoundsUtils.boundsContain(bounds, rotatedBounds) ||
      intersectPolygonBounds(corners, bounds).length > 0
    )
  }

  getExpandedBounds = () => {
    return BoundsUtils.expandBounds(this.getBounds(), this.bindingDistance)
  }

  // Migrated from tldraw/tldraw
  getBindingPoint = (
    point: number[],
    origin: number[],
    direction: number[],
    bindAnywhere: boolean
  ) => {
    // Algorithm time! We need to find the binding point (a normalized point inside of the shape, or around the shape, where the arrow will point to) and the distance from the binding shape to the anchor.

    const bounds = this.getBounds()
    const expandedBounds = this.getExpandedBounds()

    // The point must be inside of the expanded bounding box
    if (!PointUtils.pointInBounds(point, expandedBounds)) return

    const intersections = intersectRayBounds(origin, direction, expandedBounds)
      .filter(int => int.didIntersect)
      .map(int => int.points[0])

    if (!intersections.length) return

    // The center of the shape
    const center = this.getCenter()

    // Find furthest intersection between ray from origin through point and expanded bounds. TODO: What if the shape has a curve? In that case, should we intersect the circle-from-three-points instead?
    const intersection = intersections.sort((a, b) => Vec.dist(b, origin) - Vec.dist(a, origin))[0]

    // The point between the handle and the intersection
    const middlePoint = Vec.med(point, intersection)

    // The anchor is the point in the shape where the arrow will be pointing
    let anchor: number[]

    // The distance is the distance from the anchor to the handle
    let distance: number

    if (bindAnywhere) {
      // If the user is indicating that they want to bind inside of the shape, we just use the handle's point
      anchor = Vec.dist(point, center) < BINDING_DISTANCE / 2 ? center : point
      distance = 0
    } else {
      if (Vec.distanceToLineSegment(point, middlePoint, center) < BINDING_DISTANCE / 2) {
        // If the line segment would pass near to the center, snap the anchor the center point
        anchor = center
      } else {
        // Otherwise, the anchor is the middle point between the handle and the intersection
        anchor = middlePoint
      }

      if (PointUtils.pointInBounds(point, bounds)) {
        // If the point is inside of the shape, use the shape's binding distance

        distance = this.bindingDistance
      } else {
        // Otherwise, use the actual distance from the handle point to nearest edge
        distance = Math.max(
          this.bindingDistance,
          BoundsUtils.getBoundsSides(bounds)
            .map(side => Vec.distanceToLineSegment(side[1][0], side[1][1], point))
            .sort((a, b) => a - b)[0]
        )
      }
    }

    // The binding point is a normalized point indicating the position of the anchor.
    // An anchor at the middle of the shape would be (0.5, 0.5). When the shape's bounds
    // changes, we will re-recalculate the actual anchor point by multiplying the
    // normalized point by the shape's new bounds.
    const bindingPoint = Vec.divV(Vec.sub(anchor, [expandedBounds.minX, expandedBounds.minY]), [
      expandedBounds.width,
      expandedBounds.height,
    ])

    return {
      point: Vec.clampV(bindingPoint, 0, 1),
      distance,
    }
  }

  @computed get center(): number[] {
    return this.getCenter()
  }

  @computed get bounds(): TLBounds {
    return this.getBounds()
  }

  @computed get rotatedBounds(): TLBounds {
    return this.getRotatedBounds()
  }

  getSerialized = (): TLShapeModel<P> => {
    return toJS({ ...this.props, type: this.type, nonce: this.nonce } as TLShapeModel<P>)
  }

  protected getCachedSerialized = (): TLShapeModel<P> => {
    if (this.isDirty || !this.lastSerialized) {
      this.nonce++
      this.setIsDirty(false)
      this.setLastSerialized(this.getSerialized())
    }
    if (this.lastSerialized) {
      return this.lastSerialized
    }
    throw new Error('Should not get here for getCachedSerialized')
  }

  @computed
  get serialized(): TLShapeModel<P> | null {
    return this.draft ? null : this.getCachedSerialized()
  }

  validateProps = (
    props: Partial<TLShapeProps> & Partial<P>
  ): Partial<TLShapeProps> & Partial<P> => {
    return props
  }

  @action update = (props: Partial<TLShapeProps & P & any>, isDeserializing = false) => {
    if (!(isDeserializing || this.isDirty)) this.isDirty = true
    Object.assign(this.props, this.validateProps(props as Partial<TLShapeProps> & Partial<P>))
    return this
  }

  clone = (): this => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return new this.constructor(this.serialized)
  }

  onResetBounds = (info: TLResetBoundsInfo<any>) => {
    return this
  }

  protected scale: number[] = [1, 1]

  onResizeStart = (info: TLResizeStartInfo) => {
    this.scale = [...(this.props.scale ?? [1, 1])]
    return this
  }

  onResize = (initialProps: TLShapeModel<P>, info: TLResizeInfo) => {
    const {
      bounds,
      rotation,
      scale: [scaleX, scaleY],
    } = info
    const nextScale = [...this.scale]
    if (scaleX < 0) nextScale[0] *= -1
    if (scaleY < 0) nextScale[1] *= -1
    this.update({ point: [bounds.minX, bounds.minY], scale: nextScale, rotation })
    return this
  }

  onHandleChange = (initialShape: any, { id, delta }: TLHandleChangeInfo) => {
    if (initialShape.handles === undefined) return
    const nextHandles: Record<string, TLHandle> = deepCopy(initialShape.handles)
    nextHandles[id] = {
      ...nextHandles[id],
      point: Vec.add(delta, initialShape.handles[id].point),
    }
    const topLeft = BoundsUtils.getCommonTopLeft(Object.values(nextHandles).map(h => h.point))
    Object.values(nextHandles).forEach(h => {
      h.point = Vec.sub(h.point, topLeft)
    })
    this.update({
      point: Vec.add(initialShape.point, topLeft),
      handles: nextHandles,
    })
  }

  /**
   * Get a svg group element that can be used to render the shape with only the props data. In the
   * base, draw any shape as a box. Can be overridden by subclasses.
   */
  getShapeSVGJsx(preview = false) {
    // Do not need to consider the original point here
    const bounds = this.getBounds()
    return (
      <rect
        fill="var(--tl-foreground)"
        fillOpacity={0.2}
        width={bounds.width}
        height={bounds.height}
      />
    )
  }
}