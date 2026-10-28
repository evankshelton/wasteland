// The world map as a black-and-white, hand-inked chart (scripts/map_view.gd).
//
// Every tile id the client knows sits in one R8 texture (255 = uncharted).
// The map is drawn in symbol cells of `cell` x `cell` tiles, sized so a symbol
// is always 30-60 screen px whatever the zoom: each cell samples the terrain
// near its middle and inks one symbol for it - peaks with shaded flanks for
// mountains, bumps for hills, round trees, wave strokes on water, marsh tufts,
// sand ripples. Symbols are drawn back to front
// so nearer peaks and trees cover the ones behind. Shorelines follow a cubic
// B-spline through the water tiles, so they're true curves rather than tile
// steps, and wobble a little with noise. Roads are straight dashed strokes
// along a coarse road network map_view.gd works out from the road tiles: they
// show where a road goes, not every bend. Towns (ruins), the base and
// encampments are drawn by map_view.gd.
shader_type canvas_item;
render_mode unshaded;

uniform sampler2D tiles : filter_nearest; // tile ids; 255 = uncharted
uniform vec2 tiles_origin; // world tile at texel (0, 0)
uniform vec2 tiles_size; // texels
uniform vec2 view_origin; // world tile position at the rect's top-left corner
uniform vec2 rect_size; // screen px
uniform float zoom = 8.0; // screen px per tile
uniform float cell = 4.0; // tiles per symbol cell
uniform int class_of[64]; // tile id -> symbol class (the C_ constants)
// The road network: a texel per road_cell x road_cell tiles, over the same area as `tiles`.
// RG: where the road's point in that cell is (0-1 across it), B: link bits (ROAD_DIRS), A: 1 if any.
uniform sampler2D roads : filter_nearest;
uniform float road_cell = 8.0;
uniform vec4 paper : source_color = vec4(0.94, 0.93, 0.89, 1.0);
uniform vec4 ink : source_color = vec4(0.07, 0.07, 0.07, 1.0);
uniform vec4 uncharted : source_color = vec4(0.02, 0.02, 0.02, 1.0);

const int C_UNKNOWN = -1;
const int C_PLAIN = 0;
const int C_SCRUB = 1;
const int C_FOREST = 2;
const int C_RUBBLE = 3;
const int C_RUINS = 4;
const int C_ROAD = 5;
const int C_HILLS = 6;
const int C_MOUNTAINS = 7;
const int C_CRATER = 8;
const int C_RADIATION = 9;
const int C_WATER = 10;
const int C_SWAMP = 11;
const int C_DUNES = 12;
const int C_BUILT = 13;
const vec2 ROAD_DIRS[8] = vec2[](vec2(1, 0), vec2(1, 1), vec2(0, 1), vec2(-1, 1), vec2(-1, 0), vec2(-1, -1), vec2(0, -1), vec2(1, -1));

#define v_px (1.0 / (zoom * cell)) // a screen pixel, in symbol cells
#define t_px (1.0 / zoom) // a screen pixel, in tiles

float hash12(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * 0.1031);
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
	vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
	p3 += dot(p3, p3.yzx + 33.33);
	return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}

int class_at(vec2 t) {
	ivec2 c = ivec2(floor(t - tiles_origin));
	if (c.x < 0 || c.y < 0 || float(c.x) >= tiles_size.x || float(c.y) >= tiles_size.y) {
		return C_UNKNOWN;
	}
	int id = int(texelFetch(tiles, c, 0).r * 255.0 + 0.5);
	return id < 64 ? class_of[id] : C_UNKNOWN;
}

float wet_at(vec2 t) {
	return class_at(t) == C_WATER ? 1.0 : 0.0;
}

// How watery p is, as a cubic B-spline through the tile centres (x), with its
// gradient (yz). The shore is where it's 0.5: a smooth curve, not tile steps.
vec3 wetness(vec2 p) {
	vec2 q = p - 0.5;
	vec2 i0 = floor(q);
	vec2 t = q - i0;
	vec2 t2 = t * t;
	vec2 t3 = t2 * t;
	vec2 r = 1.0 - t;
	vec2 w[4] = vec2[](r * r * r / 6.0, (3.0 * t3 - 6.0 * t2 + 4.0) / 6.0, (-3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0) / 6.0, t3 / 6.0);
	vec2 d[4] = vec2[](-0.5 * r * r, 1.5 * t2 - 2.0 * t, -1.5 * t2 + t + 0.5, 0.5 * t2);
	vec3 v = vec3(0.0);
	for (int j = 0; j < 4; j++) {
		for (int i = 0; i < 4; i++) {
			float m = wet_at(i0 + vec2(float(i - 1), float(j - 1)));
			v += m * vec3(w[i].x * w[j].y, d[i].x * w[j].y, w[i].x * d[j].y);
		}
	}
	return v;
}

vec4 road_node(vec2 c) {
	ivec2 p = ivec2(floor(c - tiles_origin / road_cell));
	if (p.x < 0 || p.y < 0 || float(p.x) >= tiles_size.x / road_cell || float(p.y) >= tiles_size.y / road_cell) {
		return vec4(0.0);
	}
	return texelFetch(roads, p, 0);
}

// ---- pen and shapes (in symbol cells) ----

// Half the pen's width: about a pixel, a touch bolder on big symbols.
float pen_w() {
	return v_px * 0.65 + 0.006;
}

float pen(float d, float w) {
	return 1.0 - smoothstep(w, w + v_px, d);
}

// The same pen, for lines measured in tiles (coasts and roads).
float pen_t(float d, float w) {
	return 1.0 - smoothstep(w, w + t_px, d);
}

float seg(vec2 p, vec2 a, vec2 b) {
	vec2 pa = p - a;
	vec2 ba = b - a;
	float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
	return length(pa - ba * h);
}

float box(vec2 p, vec2 b) {
	vec2 d = abs(p) - b;
	return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float tri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
	vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
	vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
	vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
	vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
	vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
	float s = sign(e0.x * e2.y - e0.y * e2.x);
	vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
			vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
			vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
	return -sqrt(d.x) * sign(d.y);
}

float inside(float d) {
	return 1.0 - smoothstep(-v_px * 0.5, v_px * 0.5, d);
}

// A tuft of grass: three short strokes fanning up from u = 0.
float tuft(vec2 u, float s) {
	u /= s;
	float d = min(seg(u, vec2(-0.03, 0.0), vec2(-0.1, -0.12)), seg(u, vec2(0.0, 0.0), vec2(0.0, -0.16)));
	return min(d, seg(u, vec2(0.03, 0.0), vec2(0.1, -0.12))) * s;
}

// ---- symbols: return (fill with paper, stroke with ink) ----

vec2 mountain(vec2 u, float h) {
	float s = 0.85 + h * 0.5;
	vec2 apex = vec2((h - 0.5) * 0.2, -0.95) * s;
	vec2 l = vec2(-0.62, 0.0) * s;
	vec2 r = vec2(0.62, 0.0) * s;
	float d = tri(u, l, apex, r);
	float w = pen_w();
	float outline = min(seg(u, l, apex), seg(u, apex, r));
	float ridge = seg(u, apex, apex + vec2(0.1, 0.45) * s);
	// Shade the right flank with strokes running down from the ridge.
	float shade = abs(fract((u.x * 1.6 + u.y * 0.55) / s * 7.0) - 0.5) / 7.0 * s;
	float flank = step(apex.x + (u.y - apex.y) * 0.25, u.x) * smoothstep(0.02, -0.06, d);
	float stroke = max(pen(min(outline, ridge), w), pen(shade, w * 0.6) * flank);
	return vec2(inside(d), stroke);
}

vec2 hill(vec2 u, float h) {
	vec2 r = vec2(0.42, 0.24) * (0.8 + h * 0.4);
	float d = (length(u / r) - 1.0) * min(r.x, r.y);
	float top = step(u.y, 0.0);
	float shade = seg(u, vec2(r.x * 0.35, -r.y * 0.55), vec2(r.x * 0.55, -r.y * 0.1));
	return vec2(inside(d) * top, max(pen(abs(d), pen_w()) * top, pen(shade, pen_w() * 0.7)));
}

vec2 tree(vec2 u, float s) {
	vec2 c = vec2(0.0, -0.32) * s;
	float r = 0.17 * s;
	float d = length(u - c) - r;
	float trunk = seg(u, vec2(0.0, -0.15) * s, vec2(0.0, 0.0));
	float shade = length(u - c - vec2(0.07, 0.05) * s) - r * 0.45; // a little shading low on the crown
	float stroke = max(pen(abs(d), pen_w()), pen(trunk, pen_w()) * step(0.0, d));
	stroke = max(stroke, pen(abs(shade), pen_w() * 0.5) * step(d, 0.0) * step(c.y + r * 0.1, u.y));
	return vec2(inside(d), stroke);
}

// Layer symbol b in front of a.
vec2 over(vec2 a, vec2 b) {
	return vec2(max(a.x, b.x), max(a.y * (1.0 - b.x), b.y));
}

// A clump of trees, back to front.
vec2 forest(vec2 u, float h) {
	vec2 a = tree(u - vec2(-0.2, -0.18), 0.75 + h * 0.2);
	a = over(a, tree(u - vec2(0.22, -0.12), 0.8));
	if (h > 0.3) a = over(a, tree(u - vec2(-0.05, 0.05), 0.95));
	if (h > 0.6) a = over(a, tree(u - vec2(0.3, 0.2), 0.7));
	return a;
}

vec2 crater(vec2 u, float h) {
	vec2 r = vec2(0.4, 0.24) * (0.8 + h * 0.4);
	vec2 p = u + vec2(0.0, 0.15);
	float d = (length(p / r) - 1.0) * r.y;
	float inner = (length((p - vec2(0.0, 0.05)) / (r * 0.7)) - 1.0) * r.y * 0.7;
	float shade = abs(fract((p.x - p.y) * 14.0) - 0.5) / 14.0;
	float stroke = max(pen(abs(d), pen_w()), pen(abs(inner), pen_w() * 0.7) * step(p.y, 0.0));
	stroke = max(stroke, pen(shade, pen_w() * 0.5) * step(inner, 0.0) * step(p.y, 0.0));
	return vec2(inside(d), stroke);
}

// The symbol for one cell, at u from its anchor.
vec2 symbol(int k, vec2 u, float h, float h2) {
	float w = pen_w();
	if (k == C_MOUNTAINS) return h2 < 0.85 ? mountain(u, h) : vec2(0.0);
	if (k == C_HILLS) return h2 < 0.6 ? hill(u, h) : vec2(0.0);
	if (k == C_FOREST) return forest(u, h);
	if (k == C_CRATER) return h2 < 0.7 ? crater(u, h) : vec2(0.0);
	if (k == C_SCRUB) {
		if (h2 > 0.6) return vec2(0.0);
		float d = tuft(u, 1.0);
		if (h > 0.5) d = min(d, tuft(u - vec2(0.18, 0.08), 0.8));
		return vec2(0.0, pen(d, w * 0.8));
	}
	if (k == C_PLAIN) {
		h2 /= smoothstep(16.0, 48.0, zoom * cell) + 0.001; // fewer specks when the symbols get small
		if (h2 < 0.1) return vec2(0.0, pen(tuft(u, 0.7), w * 0.8));
		if (h2 < 0.2) return vec2(0.0, pen(min(length(u) - 0.015, length(u - vec2(0.12, 0.04)) - 0.012), w * 0.6));
		return vec2(0.0);
	}
	if (k == C_RUBBLE) {
		float d = min(length(u) - 0.03, length(u - vec2(0.15, -0.08)) - 0.022);
		d = min(d, length(u - vec2(-0.12, 0.09)) - 0.026);
		return vec2(0.0, pen(d, w * 0.5));
	}
	if (k == C_RADIATION) { // stipple
		float d = 9.0;
		for (int i = 0; i < 7; i++) {
			vec2 o = hash22(vec2(h * 91.0 + float(i) * 7.3, h2 * 37.0)) - 0.5;
			d = min(d, length(u + vec2(0.0, 0.3) - o * 0.8) - 0.02);
		}
		return vec2(0.0, pen(d, w * 0.5));
	}
	if (k == C_WATER) {
		if (h2 > 0.4) return vec2(0.0);
		float x = clamp(u.x, -0.2, 0.2);
		float d = length(vec2(u.x - x, u.y + 0.2 - sin(x * 30.0) * 0.025));
		return vec2(0.0, pen(d, w * 0.7));
	}
	if (k == C_SWAMP) {
		if (h2 > 0.75) return vec2(0.0);
		float d = seg(u, vec2(-0.18, 0.0), vec2(0.18, 0.0));
		d = min(d, min(seg(u, vec2(-0.07, 0.0), vec2(-0.1, -0.12)), seg(u, vec2(0.0, 0.0), vec2(0.0, -0.15))));
		d = min(d, seg(u, vec2(0.07, 0.0), vec2(0.1, -0.12)));
		return vec2(0.0, pen(d, w * 0.7));
	}
	if (k == C_DUNES) {
		if (h2 > 0.6) return vec2(0.0);
		float x = clamp(u.x, -0.28, 0.28);
		float d = length(vec2(u.x - x, u.y - (x * x * 2.2 - 0.08)));
		return vec2(0.0, pen(d, w * 0.8));
	}
	if (k == C_BUILT) return vec2(1.0, pen(abs(box(u + vec2(0.0, 0.25), vec2(0.3, 0.25))), w));
	return vec2(0.0);
}

void fragment() {
	vec2 sp = UV * rect_size; // screen px
	vec2 w = view_origin + sp / zoom; // world, in tiles

	// Region borders wobble: look regions up at a noise-warped position.
	vec2 ww = w + (vec2(vnoise(w * 0.3), vnoise(w * 0.3 + 17.3)) - 0.5) * 0.7;
	vec2 rc = floor(ww);
	int region = class_at(rc);
	if (region == C_UNKNOWN) {
		COLOR = uncharted;
	} else {
		float grain = vnoise(sp * 0.7) * 0.5 + vnoise(sp * 0.13) * 0.5;
		vec3 blank = paper.rgb * (0.96 + 0.04 * grain);
		vec3 col = blank;

		// The shore: signed distance in tiles, + out in the water.
		vec3 wv = wetness(ww);
		float sd = (wv.x - 0.5) / max(length(wv.yz), 0.05);
		bool in_water = sd > 0.0;

		// Symbols, one per cell, back to front; land symbols stay on land, waves on the water.
		vec2 lw = w / cell; // world, in cells
		vec2 home = floor(lw);
		for (int oy = -1; oy <= 2; oy++) {
			for (int ox = -1; ox <= 1; ox++) {
				vec2 q = home + vec2(float(ox), float(oy));
				vec2 jitter = hash22(q) - 0.5;
				int k = class_at((q + 0.5 + jitter * 0.6) * cell);
				if (k == C_UNKNOWN || k == C_ROAD || (k == C_WATER) != in_water) continue;
				float h = hash12(q);
				float h2 = hash12(q + 71.7);
				vec2 anchor = q + vec2(0.5, 0.75) + jitter * vec2(0.5, 0.3);
				vec2 fs = symbol(k, lw - anchor, h, h2);
				col = mix(col, blank, fs.x);
				col = mix(col, ink.rgb, fs.y);
			}
		}

		// The shoreline in pen, with the shore itself kept clear of symbols.
		float tw = t_px * 0.7;
		col = mix(col, blank, pen_t(abs(sd), max(0.3, t_px * 4.0)));
		col = mix(col, ink.rgb, pen_t(abs(sd), tw * 1.4));

		// Roads: straight dashes between the points of the road network.
		vec2 rw = w / road_cell;
		vec2 rcell = floor(rw);
		float rd = 9.0;
		float along = 0.0;
		for (int j = -1; j <= 1; j++) {
			for (int i = -1; i <= 1; i++) {
				vec2 q = rcell + vec2(float(i), float(j));
				vec4 n = road_node(q);
				if (n.a < 0.5) continue;
				int bits = int(n.b * 255.0 + 0.5);
				for (int k = 0; k < 8; k++) {
					if (((bits >> k) & 1) == 0) continue;
					vec2 qb = q + ROAD_DIRS[k];
					// Measure from the same end whichever cell draws it, so the dashes agree.
					vec2 a = k < 4 ? q + n.rg : qb + road_node(qb).rg;
					vec2 b = k < 4 ? qb + road_node(qb).rg : q + n.rg;
					vec2 pa = rw - a;
					vec2 ba = b - a;
					float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
					float d = length(pa - ba * h);
					if (d < rd) {
						rd = d;
						along = h * length(ba);
					}
				}
			}
		}
		rd *= road_cell;
		float dash_px = fract(along * road_cell * zoom / 11.0) * 11.0; // 6 px dash, 5 px gap
		float dash = smoothstep(0.0, 1.0, dash_px) * (1.0 - smoothstep(6.0, 7.0, dash_px));
		col = mix(col, blank, pen_t(rd, max(tw * 3.0, 0.15)));
		col = mix(col, ink.rgb, pen_t(rd, tw * 1.2) * dash);
		COLOR = vec4(col, 1.0);
	}
}
