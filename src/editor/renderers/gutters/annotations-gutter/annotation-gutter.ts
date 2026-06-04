/**
 * This gutter is a modified version of the one defined in @codemirror/view/gutter
 * The main changes are:
 *  1. Gutter is inserted next to the contentDOM (instead of before)
 *  2. Height of gutterElement is not specified
 *  3. GutterElement can be of arbitrary height
 *  4. Added annotation listeners for focusing GutterMarkers
 *  5. Gutter *can* be zero-width if there are no markers in the document
 */
import {Annotation, type Extension, Facet} from "@codemirror/state";
import { BlockInfo, EditorView, GutterMarker, ViewUpdate } from "@codemirror/view";

import { debounce, editorInfoField, setIcon } from "obsidian";
import {
	createGutter,
	createGutterViewPlugin,
	type GutterConfig,
	GutterElement,
	GutterView,
	sameMarkers,
	SingleGutterView,
	UpdateContext,
} from "../base";
import { annotationGutterMarkers, AnnotationMarker } from "./marker";
import { annotationGutterCompartment } from "./index";
import { markupFocusEffect } from "../../live-preview";

// EXPL: Margin between the gutter and the content
const ANNOTATION_GUTTER_MARGIN = 24;

// EXPL: Minimum editor content width to preserve while the annotation gutter is shown.
//       If the viewport is too narrow to keep this much content next to the gutter
//       (e.g. a narrow split pane, small window, or pop-out), the gutter auto-folds.
const MIN_CONTENT_WIDTH = 200;

// EXPL: Smallest width the gutter can be dragged to via the resize handle. Prevents the
//       handle from being dragged down to 0px, where it becomes too thin to grab again.
//       (Full collapse is what the fold button is for.)
const MIN_GUTTER_WIDTH = 120;

const unfixGutters = Facet.define<boolean, boolean>({
	combine: values => values.some(x => x),
});

const activeGutters = Facet.define<Required<AnnotationGutterConfig>>();

export const annotationGutterFocusAnnotation = Annotation.define<{ from: number, to: number, index?: number, scroll?: boolean }>();
export const annotationGutterFoldAnnotation = Annotation.define<boolean | null>();
export const annotationGutterFocusThreadAnnotation = Annotation.define<{ marker: AnnotationMarker, index: number, scroll?: boolean, focus_markup?: boolean }>();
export const annotationGutterWidthAnnotation = Annotation.define<number>();
export const annotationGutterHideEmptyAnnotation = Annotation.define<boolean>();
export const annotationGutterFoldButtonAnnotation = Annotation.define<boolean>();
export const annotationGutterResizeHandleAnnotation = Annotation.define<boolean>();

export class AnnotationGutterView extends GutterView {
	declare gutters: AnnotationSingleGutterView[];

	previously_focused: AnnotationMarker | undefined = undefined;

	constructor(view: EditorView) {
		super(view, unfixGutters, activeGutters);
		// FIXME: this still causes a layout shift
		// EXPL: If the gutter is not inside a Markdown View, hide it and remove it from the gutter extension from the view
		if (!view.dom.parentElement!.classList.contains("markdown-source-view")) {
			// NOTE: Prevents gutter from appearing for a brief second (until setImmediate kicks in)
			this.dom.style.display = 'none';
			// NOTE: Codemirror doesn't allow state changes during updates, so reconfiguration needs to be delayed
			setImmediate(() => {
				view.dispatch(view.state.update({
					effects: [
						annotationGutterCompartment.reconfigure([])
					]
				}));
			});
		}
	}

	// EXPL: When moving a selection inside the editor, multiple moveGutter calls are triggered,
	//       causing wonkyness and ever greater up/downwards movement
	debouncedMoveGutter = debounce(this.moveGutter.bind(this), 200);

	createGutters(view: EditorView) {
		return view.state.facet(activeGutters).map(conf => new AnnotationSingleGutterView(view, conf, this.dom));
	}

	insertGutters(view: EditorView) {
		view.contentDOM.parentNode!.insertBefore(this.dom, view.contentDOM.nextSibling);
	}

	insertDetachedGutters(after: HTMLElement) {
		this.view.contentDOM.parentNode!.insertBefore(this.dom, this.view.contentDOM.nextSibling);
	}

	getUpdateContexts(): UpdateContext[] {
		return (this.gutters as AnnotationSingleGutterView[]).map(gutter =>
			new AnnotationUpdateContext(gutter, this.view.viewport, -this.view.documentPadding.top)
		);
	}

	update(update: ViewUpdate) {
		for (const transaction of update.transactions) {
			const thread_focus = transaction.annotation(annotationGutterFocusThreadAnnotation);
			if (thread_focus) {
				const { marker, index, scroll = false, focus_markup = false } = thread_focus;
				this.unfocusAnnotation();
				this.focusAnnotation(marker, index, scroll, focus_markup);
			}
		}
		super.update(update);
	}

	unfocusAnnotation() {
		this.previously_focused?.unfocus_annotation();
		this.previously_focused = undefined;
	}

	focusAnnotation(marker: AnnotationMarker, index: number, scroll: boolean = false, focus_markup = false) {
		this.previously_focused = marker;
		this.debouncedMoveGutter(marker);
		marker.focus_annotation(index, scroll);

		if (focus_markup) {
			activeWindow.setTimeout(() => {
				this.view.dispatch(
					this.view.state.update({
						effects: [
							markupFocusEffect.of({
								from: marker.annotation.from,
								to: marker.annotation.full_range_back
							})
						]
					})
				);
			});
		}
	}

	updateGutters(update: ViewUpdate): boolean {
		// EXPL: Check all transactions, figure out if they have been annotated with a focus shift annotation
		// TODO: Is there a better way to check the annotations of a ViewUpdate?
		const annotation = update.transactions.flatMap(tr => tr.annotation(annotationGutterFocusAnnotation)).find(e => e);
		if (annotation || update.startState.selection !== update.state.selection) {
			this.unfocusAnnotation();
		}

		if (annotation) {
			const { from, to, index = -1, scroll = false } = annotation;

			// EXPL: Find a GutterElement and then GutterMarker that contains the cursor
			// NOTE: In a previous version of this code, AnnotationGutterElement's `block.to` was used
			//       in order to find the GutterMarker that contains the cursor, however,
			//       the block only represents the starting line of the GutterElement, and does not work
			//       for markers that span multiple lines
			// TODO: Improve the performance of this code, I am not a big fan of linearly searching like this
			// NOTE: Did you know you can label loops? I didn't. Neat huh?
			outer_loop:
			for (const element of this.gutters[0].elements as AnnotationGutterElement[]) {
				if (from >= element.block!.from) {
					for (const marker of element.markers as AnnotationMarker[]) {
						if (from >= marker.annotation.from && to <= marker.annotation.full_range_back) {
							this.focusAnnotation(marker, index, scroll);
							break outer_loop;
						}
					}
				} else if (from < element.block!.from) {
					break;
				}
			}
		}

		return super.updateGutters(update);
	}

	/**
	 * Moves the initial GutterElement of the gutter up or down to align provided marker with its block
	 * @param marker - Marker to align the gutter by
	 */
	public moveGutter(marker: GutterMarker) {
		// NOTE: We can assume that only one gutter exists
		const activeGutter = this.gutters[0];

		// EXPL: Given the 'highlighted' marker, fetch the gutterElement it belongs to
		const element = activeGutter.elements.find(element => element.markers.includes(marker)) as AnnotationGutterElement | undefined;
		if (!element) {
			return;
		}
		const markerIndex = element.markers.indexOf(marker);

		// EXPL: Where the gutter element should be located (i.e. flush with the top of the block)
		const desiredLocation = element.block!.top;
		// EXPL: Where the gutter element is currently located (possibly pushed down by other gutter elements)
		// FIXME: offsetTop not defined error (repr: when interacting in phantom comment note)
		const currentLocation = (element.dom.children[markerIndex] as HTMLElement).offsetTop;

		// EXPL: Determine the offset between the current location and the desired location
		let offset = desiredLocation - currentLocation;

		// EXPL: It is preferred not to make micro-adjustments on the gutter, so a small offset is ignored
		if (Math.abs(offset) >= 10 && offset) {
			const element = activeGutter.elements[0];
			element.dom.style.marginTop = parseInt(element.dom.style.marginTop || "0") + offset + "px";
		}
	}

	public foldGutter() {
		(this.gutters[0] as AnnotationSingleGutterView).foldGutter();
	}
}

export const annotationGutterView = createGutterViewPlugin(AnnotationGutterView);

export interface AnnotationGutterConfig extends GutterConfig {
	/**
	 * Whether the gutter should be folded by default
	 */
	foldState: boolean;

	/**
	 * The width of the gutter in pixels
	 */
	width: number;

	/**
	 * Whether the gutter should be hidden when empty
	 */
	hideOnEmpty: boolean;

	/**
	 * Whether the gutter should include a fold button
	 */
	includeFoldButton: boolean;

	/**
	 * Whether the gutter should include a resize handle
	 */
	includeResizeHandle: boolean;
}


export function annotation_gutter(config: AnnotationGutterConfig): Extension {
	return createGutter(annotationGutterView, config, activeGutters, unfixGutters);
}

class AnnotationUpdateContext extends UpdateContext {
	/**
	 * Describes the y-position of the bottom of the previous gutter element
	 */
	previous_element_end: number = 0;
	new_gutter_elements: AnnotationGutterElement[] = [];
	added_elements: AnnotationGutterElement[] = [];

	constructor(
		readonly gutter: AnnotationSingleGutterView,
		viewport: { from: number; to: number },
		public height: number,
	) {
		super(gutter, viewport, height);
		this.previous_element_end = height;
	}

	async addElement(view: EditorView, block: BlockInfo, markers: readonly GutterMarker[]) {
		/**
		 * Describes the amount of space between the previous gutter element and the y-postion for the one that will be constructed for the current block
		 * @remark This prevents the overlap of the gutter elements
		 */
		const above = Math.max(block.top - this.previous_element_end, 0);
		/**
		 * Iff there is overlap with the previous block (i.e. the top of the block is lower than the bottom of the previous gutter element),
		 * then place the gutter element at the bottom of the previous gutter element (above = 0)
		 */
		const block_start = above <= 0 ? this.previous_element_end : block.top;

		/**
		 * SOLUTION: ensures ordering of markers of same block (bit inefficient but very easy solution)
		 * Works by sorting the markers in-place
		 * @todo Investigate whether the markers can be sorted earlier in the pipeline
		 */
		// FIXME: Marker without comment_range issue
		// NOTE: This may be addresses by using the startSide bias in gutterMarker (warning: update concern)
		(markers as unknown as AnnotationMarker[])
			.sort((a, b) => a.annotation.from - b.annotation.from);

		const UNKNOWN_HEIGHT = 36;

		/**
		 * Complete height of the GutterElement, including BOTTOM margin (i.e. spacing between gutter elements)
		 * @remark The reason *why* this is an absolutely essential value, is that it ensures that no elements can overlap,
		 *     if estimated height is lower than actual height, then GutterElements of two blocks risk overlapping
		 *     if estimated height is higher than actual height, then GutterElements will have an unnecessarily large gap between them
		 *   however, we cannot directly grab the height of the element, as it is not yet rendered, so we need to either:
		 *   	1. Estimate the height of the element (clunky, and error-prone with different styles)
		 *   	2. Wait till element is rendered, grab height from rendered element
		 * @remark Current implementation relies on the fact that CodeMirror does a second pass through all of the elements,
		 *     at which point the height of the gutter element is known due to the DOM being rendered
		 *     when SyncGutter is called, the height is again reset to 0, which causes desync issues and additional gutter movement
		 * @warning This is THE only part of the algorithm that needs an implementation (a.k.a. the unsettled height problem),
		 * 	   in short, a better approximation for UNKNOWN_HEIGHT when the element is not rendered yet would be fantastic
		 * 	   please - and I mean this with all sincerity in the world - please let me know if you are able to come up with a more elegant solution
		 */
		const height = this.gutter.elements[this.i]?.dom.clientHeight || UNKNOWN_HEIGHT;


		// EXPL: Search for an existing GutterElement with the same markers
		const element_idx = this.gutter.elements
			.findIndex(e => sameMarkers(e.markers, markers));

		// EXPL: If a GutterElement already exists, and it has the exact same markers,
		//      remove all the GutterElements before this element
		//    	and re-insert all the newly added elements before this element
		if (element_idx !== -1) {
			const element = this.gutter.elements[element_idx];
			for (let i = this.i; i < element_idx; i++) {
				this.gutter.dom.removeChild(this.gutter.elements[i].dom);
				this.gutter.elements[i].destroy();
			}
			for (const added_element of this.added_elements)
				this.gutter.dom.insertBefore(added_element.dom, element.dom);
			this.new_gutter_elements.push(...this.added_elements);
			this.added_elements = [];

			this.i = element_idx + 1;
			this.new_gutter_elements.push(element);
			element.update(view, height, above, markers, block);
		}

		// EXPL: Otherwise, if the GutterElement does not exist, create a new one and it to the gutter later
		else {
			this.added_elements.push(new AnnotationGutterElement(view, height, above, markers, block));
		}

		this.previous_element_end = block_start + height;
	}

	finish() {
		// EXPL: Finally, at the end of the update, remove all remaining GutterElements
		for (let i = this.i; i < this.gutter.elements.length; i++) {
			this.gutter.dom.removeChild(this.gutter.elements[i].dom);
			this.gutter.elements[i].destroy();
		}

		// EXPL: Add all the remaining added GutterElements to the gutter
		for (const added_element of this.added_elements) {
			this.gutter.dom.appendChild(added_element.dom);
		}
		this.gutter.elements = [...this.new_gutter_elements, ...this.added_elements];
		this.new_gutter_elements = [];
		this.added_elements = [];
	}
}

class AnnotationSingleGutterView extends SingleGutterView {
	folded: boolean = false;
	// EXPL: Transient fold forced by a too-narrow viewport. Kept separate from `folded`
	//       (the user's explicit, persisted preference) so the gutter restores itself
	//       once there is room again.
	auto_folded: boolean = false;
	hide_on_empty: boolean = false;
	width: number = 0;
	add_fold_button: boolean = false;
	add_resize_handle: boolean = false;

	gutter_position: number = 0;

	fold_button_el: HTMLElement | undefined = undefined;
	resize_handle_el: HTMLElement | undefined = undefined;
	resize_observer: ResizeObserver | undefined = undefined;
	declare elements: AnnotationGutterElement[];

	// EXPL: User explicitly opened the gutter while it was too narrow to auto-fit.
	//       Suppresses the viewport auto-fold until there is room again, so a resize
	//       does not immediately re-fold what the user just chose to open.
	override_open: boolean = false;

	// EXPL: Whether the gutter should currently be rendered collapsed, for any reason
	get render_folded(): boolean {
		return this.folded || this.auto_folded;
	}

	// EXPL: How much width the gutter can actually use without pushing content off-screen.
	//       With readable line width on, the gutter lives in the margin to the right of the
	//       text column. We MEASURE that gap from the live DOM rather than trusting
	//       `--file-line-width`: some setups (notably the Minimal theme / Minimal Theme
	//       Settings) render the column wider than that variable claims, which made the old
	//       `pane - file-line-width` estimate too generous and pushed the gutter off-screen.
	//       Measuring is also theme-agnostic: it works whether the column is centered (Minimal)
	//       or shifted left by the default theme's readable-width carve-out.
	private maxGutterWidth(): number {
		const pane = this.view.dom.clientWidth;
		const readable = this.view.state.field(editorInfoField).app.vault.getConfig("readableLineLength");
		if (readable) {
			const fileLineWidth = parseInt(
				getComputedStyle(this.view.scrollDOM).getPropertyValue("--file-line-width").trim(),
			);
			const contentWidth = this.view.contentDOM.clientWidth;
			// EXPL: Fast path — the column actually honours `--file-line-width` (the default
			//       readable-width carve-out). Then the column shifts left as the gutter grows,
			//       so the gutter may use the whole right margin (`pane - file-line-width`).
			if (fileLineWidth > 0 && fileLineWidth < pane && contentWidth <= fileLineWidth + 50) {
				return Math.max(0, pane - fileLineWidth);
			}
			// EXPL: Otherwise a theme renders the column wider than the variable claims (e.g.
			//       Minimal Theme Settings). The column is fixed/centered, so MEASURE the real
			//       gap to the right of it instead — exact, theme-proof, and never overflows.
			//       (Inner-right edge of the scroller; clientWidth excludes any scrollbar.)
			const scrollRect = this.view.scrollDOM.getBoundingClientRect();
			const scrollerInnerRight = scrollRect.left + this.view.scrollDOM.clientWidth;
			const contentRight = this.view.contentDOM.getBoundingClientRect().right;
			const measured = scrollerInnerRight - contentRight - ANNOTATION_GUTTER_MARGIN;
			// EXPL: A real (finite) measurement wins, even if it's 0 — that means there's
			//       genuinely no room and the gutter should fold rather than overflow.
			if (Number.isFinite(measured)) {
				return Math.max(0, Math.floor(measured));
			}
		}
		return Math.max(0, pane - MIN_CONTENT_WIDTH);
	}

	// EXPL: The gutter's rendered width, clamped so it never overflows the available margin
	private effectiveWidth(): number {
		return Math.min(this.width, this.maxGutterWidth());
	}

	// EXPL: Apply the (clamped) rendered width to the gutter and the content-sizing CSS var
	private applyEffectiveWidth() {
		const w = this.effectiveWidth();
		this.dom.style.width = w + "px";
		this.view.dom.style.setProperty("--cmtr-anno-gutter-width", w + "px");
	}

	// EXPL: True when even a minimally-usable gutter would not fit — collapse instead of overflow
	private isTooNarrow(): boolean {
		return this.maxGutterWidth() < MIN_GUTTER_WIDTH;
	}

	// EXPL: Re-evaluate the auto-fold when the editor is resized (split-pane drag,
	//       window resize, pop-out). Debounced to avoid thrashing during a drag.
	debouncedResponsiveFold = debounce(() => this.applyResponsiveFold(), 100);

	private applyResponsiveFold() {
		if (this.isTooNarrow()) {
			if (!this.folded && !this.auto_folded && !this.override_open) {
				this.auto_folded = true;
				this.foldGutter();
			}
		} else {
			// EXPL: Room again — drop the transient states and restore if we auto-folded
			this.override_open = false;
			if (this.auto_folded) {
				this.auto_folded = false;
				this.foldGutter();
			} else if (!this.render_folded) {
				// EXPL: Still open, pane just resized — reflow the clamped width to the new margin
				this.applyEffectiveWidth();
			}
		}
	}

	constructor(public view: EditorView, public config: Required<AnnotationGutterConfig>, private gutterDom: HTMLElement) {
		super(view, config);

		this.folded = config.foldState;
		this.width = config.width;
		// EXPL: If the gutter takes up too much space, fold it by default (even if the user has allowed it to be unfoled in the past)
		// if (this.view.dom.clientWidth - this.width < 200) {
		// 	this.folded = true;
		// }
		// TODO: This is specifically done for popovers, there may be a better fix for this
		if (this.view.dom.parentElement?.parentElement?.parentElement?.classList.contains("markdown-embed")) {
			this.folded = true;
		}

		this.hide_on_empty = config.hideOnEmpty;
		this.add_fold_button = config.includeFoldButton;
		this.add_resize_handle = config.includeResizeHandle;

		// EXPL: Collapse the gutter on first render if the viewport is too narrow to keep
		//       a usable amount of content beside it (does not override an explicit fold).
		if (!this.folded && this.isTooNarrow()) {
			this.auto_folded = true;
		}

		if ((this.hide_on_empty && view.state.field(annotationGutterMarkers).size === 0) || this.render_folded) {
			this.dom.style.width = "0";
		} else {
			this.dom.style.width = this.effectiveWidth() + "px";
		}
		this.view.dom.style.setProperty("--cmtr-anno-gutter-width", this.render_folded ? "0px" : this.effectiveWidth() + "px");
		this.gutterDom.style.marginInlineStart = this.render_folded ? "0" : ANNOTATION_GUTTER_MARGIN + "px";
		this.gutter_position = this.view.scrollDOM.getBoundingClientRect().right - this.view.contentDOM.getBoundingClientRect().right + ANNOTATION_GUTTER_MARGIN;

		if (this.add_fold_button) {
			this.createFoldButton();
		}

		if (this.add_resize_handle) {
			this.createResizeHandle();
		}

		// EXPL: Keep the auto-fold in sync as the editor pane is resized
		this.resize_observer = new ResizeObserver(() => this.debouncedResponsiveFold());
		this.resize_observer.observe(this.view.dom);
	}

	createFoldButton() {
		const foldButtonElement = createEl("a", { cls: ["view-action"] });
		setIcon(foldButtonElement, "arrow-right-from-line");
		foldButtonElement.setAttribute("data-tooltip-position", "left");
		foldButtonElement.style.display = this.view.state.field(annotationGutterMarkers).size ? "" : "none";
		foldButtonElement.onclick = () => {
			// EXPL: Toggle the *visible* state — if collapsed for any reason (including
			//       an auto-fold), a click opens it; if open, a click folds it.
			const currently_folded = this.render_folded;
			this.auto_folded = false;
			this.folded = !currently_folded;
			// EXPL: Opened while the pane is too narrow → remember it so the resize
			//       observer does not immediately auto-fold it back.
			this.override_open = !this.folded && this.isTooNarrow();
			this.view.state.field(editorInfoField).app.workspace.requestSaveLayout();
			this.foldGutter();
		}

		this.setFoldButtonState();
		this.fold_button_el = createDiv({ cls: ["cmtr-anno-gutter-button"] });
		this.fold_button_el.appendChild(foldButtonElement);
		this.gutterDom.appendChild(this.fold_button_el);
	}

	createResizeHandle() {
		this.resize_handle_el = createEl("hr", { cls: ["cmtr-anno-gutter-resize-handle"] });
		this.resize_handle_el.style.display = (this.view.state.field(annotationGutterMarkers).size && !this.render_folded) ? "" : "none";
		this.resize_handle_el.addEventListener("pointerdown", (e: PointerEvent) => {
			// EXPL: Primary button / primary touch only. Capture the pointer so the drag keeps
			//       tracking even when it leaves the thin handle, and so it works for touch/pen.
			//       Never resize a folded gutter — it has no visible width to drag, and doing so
			//       would force it open without the fold/margin bookkeeping.
			if (e.button !== 0 || this.render_folded) return;
			this.resize_handle_el!.setPointerCapture(e.pointerId);
			let initialPosition = e.clientX;
			let isReadableLineWidth = this.view.state.field(editorInfoField).app.vault.getConfig("readableLineLength");
			const temporarySheet = this.view.dom.doc.styleSheets[0];

			// EXPL: Debounce to prevent excessive state updates and DOM redraws while dragging the handle
			const setWidth = debounce((width: number) => {
				this.width = Math.round(Math.max(MIN_GUTTER_WIDTH, Math.min(width, this.maxGutterWidth())));
				this.view.state.field(editorInfoField).app.workspace.requestSaveLayout();
				this.dom.style.width = this.width + "px";
				this.view.dom.style.setProperty("--cmtr-anno-gutter-width", this.width + "px");

				// TODO: Improve resizing logic when user has readable line length enabled
				//       When resizing, .cm-line's width adjust even when not necessary, causing jarring content shifts
				// EXPL: Freezes the width of .cm-line to prevent content shifting, reduces the amount of shifts a lot
				//		 (Trust me, it is _much_ worse without this bodge)
				if (isReadableLineWidth) {
					temporarySheet.deleteRule(temporarySheet.cssRules.length - 1);
					temporarySheet.insertRule(`.cmtr-anno-gutter-resizing .cm-line { width: ${this.view.contentDOM.clientWidth}px !important; }`, temporarySheet.cssRules.length);
					this.gutter_position = this.view.scrollDOM.getBoundingClientRect().right - this.view.contentDOM.getBoundingClientRect().right + ANNOTATION_GUTTER_MARGIN;
				}
			}, 25);

			this.resize_handle_el!.classList.toggle("cmtr-anno-gutter-resize-handle-hover", true);
			this.view.scrollDOM.classList.toggle("cmtr-anno-gutter-resizing", true);

			let currentWidth = parseInt(this.dom.style.width.slice(0, -2));
			const onPointerMove = (evt: PointerEvent) => {
				const deltaX = evt.clientX - initialPosition;
				initialPosition = evt.clientX
				currentWidth -= deltaX;
				setWidth(currentWidth);
				return true;
			}

			const onPointerStop = () => {
				this.resize_handle_el!.removeEventListener("pointermove", onPointerMove);
				this.resize_handle_el!.removeEventListener("pointerup", onPointerStop);
				this.resize_handle_el!.removeEventListener("pointercancel", onPointerStop);
				this.resize_handle_el!.releasePointerCapture(e.pointerId);
				this.resize_handle_el!.classList.toggle("cmtr-anno-gutter-resize-handle-hover", false);
				this.view.scrollDOM.classList.toggle("cmtr-anno-gutter-resizing", false);

				if (isReadableLineWidth) {
					temporarySheet.deleteRule(temporarySheet.cssRules.length - 1);
				}
			}

			// EXPL: With the pointer captured above, move/up/cancel are delivered to the handle
			this.resize_handle_el!.addEventListener("pointermove", onPointerMove);
			this.resize_handle_el!.addEventListener("pointerup", onPointerStop);
			this.resize_handle_el!.addEventListener("pointercancel", onPointerStop);

			return true;
		});

		this.gutterDom.appendChild(this.resize_handle_el);
	}

	setFoldButtonState() {
		if (this.fold_button_el) {
			if (this.render_folded) {
				this.fold_button_el.children[0].setAttribute("style", "rotate: -180deg;");
				this.fold_button_el.children[0].ariaLabel = "Unfold gutter";
				if (this.resize_handle_el) {
					this.resize_handle_el.style.display = 'none';
				}
			} else {
				this.fold_button_el.children[0].setAttribute("style", "rotate: 0deg;");
				this.fold_button_el.children[0].ariaLabel = "Fold gutter";
				if (this.resize_handle_el) {
					this.resize_handle_el.style.display = '';
				}
			}
		}
	}

	foldGutter() {
		// EXPL: Render-time fold state combines the user's explicit fold with any
		//       viewport-driven auto-fold (see `auto_folded`)
		const folded = this.render_folded;
		// EXPL: Clamped rendered width (never wider than the available margin)
		const w = this.effectiveWidth();
		this.setFoldButtonState();

		// EXPL: Set the height for every marker to fixed so that they won't resize while the gutter is changing width
		if (folded) {
			this.elements.forEach(element => {
				Array.from(element.dom.getElementsByClassName("cmtr-anno-gutter-annotation")).forEach(comment => {
					comment.setAttribute("style", `max-height: ${comment.clientHeight}px; overflow: hidden;`);
				});
			});
		} else {
			this.dom.addEventListener("transitionend", () => {
				this.elements.forEach(element => {
					Array.from(element.dom.getElementsByClassName("cmtr-anno-gutter-annotation")).forEach(comment => {
						comment.removeAttribute("style");
					});
				});
			}, { once: true });
		}
		this.dom.style.width = folded ? "0" : w + "px";
		this.gutterDom.style.marginInlineStart = folded ? "0" : ANNOTATION_GUTTER_MARGIN + "px";

		if (this.view.state.field(editorInfoField).app.vault.getConfig("readableLineLength")) {
			// EXPL: Computes the margin before and after the gutter has been folded
			const readableLineWidth = parseInt(getComputedStyle(this.view.scrollDOM).getPropertyValue("--file-line-width").trim());
			const marginWithoutGutter = Math.max(0, this.view.scrollDOM.innerWidth - readableLineWidth);
			const marginWithGutter = Math.max(0, marginWithoutGutter - w);
			const newMargin = (folded ? marginWithoutGutter : marginWithGutter) / 2;
			const oldMargin = (folded ? marginWithGutter : marginWithoutGutter) / 2;

			// EXPL: Freeze the contentDOM to prevent content shifting while the gutter is being folded
			this.view.contentDOM.style.width = this.view.contentDOM.clientWidth + (folded ? ANNOTATION_GUTTER_MARGIN : 0) + "px !important";
			// EXPL: Set the old margin to transition from
			this.view.scrollDOM.children[0].setAttribute("style", `margin: 0 ${oldMargin}px; transition: margin 0.4s ease-in-out, max-width 0.4s ease-in-out;`);
			if (!folded) {
				this.view.dom.style.setProperty("--cmtr-anno-gutter-width", w + "px");
			}

			setTimeout(() => {
				// EXPL: Transition to the new margin
				this.view.scrollDOM.children[0].setAttribute("style", `margin: 0 ${newMargin}px; transition: margin 0.4s ease-in-out, max-width 0.4s ease-in-out;`);
				// EXPL: Whenever the gutter is finished folding, clean up all freezes
				this.dom.addEventListener("transitionend", () => {
					this.view.contentDOM.removeAttribute("style");
					this.view.scrollDOM.children[0].removeAttribute("style");
					if (folded) {
						this.view.dom.style.setProperty("--cmtr-anno-gutter-width", "0px");
					}
				}, { once: true });
			});
		}
	}

	update(update: ViewUpdate) {
		const result = super.update(update);
		const widgets = update.state.field(annotationGutterMarkers);

		for (const transaction of update.transactions) {
			const fold_status = transaction.annotation(annotationGutterFoldAnnotation);
			const width = transaction.annotation(annotationGutterWidthAnnotation);
			const hide_empty = transaction.annotation(annotationGutterHideEmptyAnnotation);
			const fold_button = transaction.annotation(annotationGutterFoldButtonAnnotation);
			const resize_handle = transaction.annotation(annotationGutterResizeHandleAnnotation);
			if (width !== undefined) {
				this.width = width;
				if (!this.hide_on_empty && !this.render_folded) {
					this.dom.style.width = this.effectiveWidth() + "px";
					this.setFoldButtonState();
				}
				this.view.dom.style.setProperty("--cmtr-anno-gutter-width", this.effectiveWidth() + "px");
				// EXPL: A wider configured width may no longer fit -- re-check the auto-fold
				this.debouncedResponsiveFold();
			}
			if (fold_status !== undefined) {
				// EXPL: An explicit fold command overrides any viewport-driven auto-fold.
				//       Toggle off the *visible* state so it is never off-by-one when auto-folded.
				const was_folded = this.render_folded;
				this.auto_folded = false;
				if (fold_status === null) {
					this.folded = !was_folded;
					this.view.state.field(editorInfoField).app.workspace.requestSaveLayout();
				} else {
					this.folded = fold_status;
				}
				this.override_open = !this.folded && this.isTooNarrow();
				this.foldGutter();
			}
			if (hide_empty !== undefined) {
				this.hide_on_empty = hide_empty;
				if (this.hide_on_empty && widgets.size === 0) {
					this.dom.style.width = "0";
				} else {
					this.dom.style.width = this.width + "px";
				}
				this.view.dom.style.setProperty("--cmtr-anno-gutter-width", this.width + "px");
			}
			if (fold_button !== undefined) {
				this.add_fold_button = fold_button;
				if (this.add_fold_button && !this.fold_button_el) {
					this.createFoldButton();
				} else if (!this.add_fold_button && this.fold_button_el) {
					this.fold_button_el.remove();
					this.fold_button_el = undefined;
				}
				this.setFoldButtonState();
			}
			if (resize_handle !== undefined) {
				this.add_resize_handle = resize_handle;
				if (this.add_resize_handle && !this.resize_handle_el) {
					this.createResizeHandle();
				} else if (!this.add_resize_handle && this.resize_handle_el) {
					this.resize_handle_el.remove();
					this.resize_handle_el = undefined;
				}
			}
		}

		if (widgets.size !== update.startState.field(annotationGutterMarkers).size) {
			if (widgets.size === 0) {
				if (this.fold_button_el) {
					this.fold_button_el.style.display = "none";
				}
				if (this.resize_handle_el) {
					this.resize_handle_el.style.display = "none";
				}
				if (this.hide_on_empty) {
					this.dom.style.width = "0";
				}
			} else {
				if (this.fold_button_el) {
					this.fold_button_el.style.display = "";
				}
				if (this.resize_handle_el) {
					// EXPL: Only reveal the resize handle when the gutter is actually open.
					//       Otherwise adding the first annotation to a folded gutter would expose
					//       a draggable handle, and dragging a folded gutter force-opens it without
					//       the fold/margin bookkeeping — pushing it off-screen.
					this.resize_handle_el.style.display = this.render_folded ? "none" : "";
				}
				if (!this.render_folded) {
					this.dom.style.width = this.width + "px";
				}
			}
		}

		// NOTE: Boolean returns true only if markers have changed within the viewport (so outside markers don't count)
		return result;
	}

	destroy() {
		this.resize_observer?.disconnect();
		this.fold_button_el?.remove();
		this.resize_handle_el?.remove();

		super.destroy();
	}
}

class AnnotationGutterElement extends GutterElement {
	constructor(
		view: EditorView,
		height: number,
		above: number,
		markers: readonly GutterMarker[],
		// IMPORTANT: The `block` variable represents the _starting_ line this GutterElement may belong to
		//		the annotations _may_ cover multiple lines, but the block will ONLY account for the first line
		//		In practice, this means that block.to IS NOT the end of the marker
		public block: BlockInfo | null = null,
	) {
		super(view, height, above, markers);
	}

	/**
	 * Comment update function that does not forcibly set the height of the gutter element
	 */
	update(
		view: EditorView,
		height: number,
		above: number,
		markers: readonly GutterMarker[],
		block: BlockInfo | null = null,
	) {
		this.block = block;
		if (this.above != above)
			this.dom.style.marginTop = (this.above = above) ? above + "px" : "";
		if (!sameMarkers(this.markers, markers))
			this.setMarkers(view, markers);
	}
}
