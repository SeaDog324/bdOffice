export interface ZoomAnchor {
  contentX: number
  contentY: number
  viewportX: number
  viewportY: number
}

/** Capture both coordinate spaces: a cursor anchor is not the viewport center. */
export function captureZoomAnchor(
  viewport: Pick<HTMLElement, 'scrollLeft' | 'scrollTop' | 'clientWidth' | 'clientHeight'>,
  point = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 },
): ZoomAnchor {
  return {
    contentX: viewport.scrollLeft + point.x,
    contentY: viewport.scrollTop + point.y,
    viewportX: point.x,
    viewportY: point.y,
  }
}

export function scrollForZoom(anchor: ZoomAnchor, ratio: number) {
  return {
    left: Math.max(0, anchor.contentX * ratio - anchor.viewportX),
    top: Math.max(0, anchor.contentY * ratio - anchor.viewportY),
  }
}
