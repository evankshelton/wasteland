// The world map in the game's own art (scripts/map_view.gd): the overworld as
// a grid of the same 16x16 EGA tiles you walk on, each standing for a cell of
// `cell` x `cell` tiles and drawn at a whole number of screen pixels per art
// pixel, so it's always crisp, chunky pixel art.
//
// Every tile id the client knows sits in one R8 texture (255 = uncharted,
// drawn black). A cell shows whichever terrain is most common among nine
// points spread over it, so regions keep their shape as detail drops away -
// except that a cell a road runs right through shows road (`roads`, worked out
// by map_view.gd), so highways stay unbroken. With show_roads off there are no
// roads at all: road tiles drop out of the vote and the land around them shows.
shader_type canvas_item;
render_mode unshaded;

uniform sampler2D tiles : filter_nearest; // tile ids; 255 = uncharted
uniform vec2 tiles_origin; // world tile at texel (0, 0)
uniform vec2 tiles_size; // texels
uniform sampler2D art : filter_nearest; // assets/tiles.png: tile id N is column N
uniform int remap[64]; // tile id -> the tile id to draw for it
uniform vec2 view_origin; // world tile position at the rect's top-left corner
uniform vec2 rect_size; // screen px
uniform float zoom = 8.0; // screen px per tile
uniform float cell = 4.0; // tiles per map cell
uniform sampler2D roads : filter_nearest; // one texel per cell (from the cell holding tiles_origin): road tiles in it / 255
uniform int road_id = 6;
uniform bool show_roads = true;
uniform int plain_id = 1; // what a cell of nothing but road shows when roads are hidden
uniform int keep_over_road[4]; // tile ids that stay themselves even with a road through them

const int UNKNOWN = 255;
const float ART = 16.0; // art pixels per tile

int tile_at(vec2 t) {
	ivec2 c = ivec2(floor(t - tiles_origin));
	if (c.x < 0 || c.y < 0 || float(c.x) >= tiles_size.x || float(c.y) >= tiles_size.y) {
		return UNKNOWN;
	}
	int id = int(texelFetch(tiles, c, 0).r * 255.0 + 0.5);
	return id < 64 ? remap[id] : UNKNOWN;
}

void fragment() {
	vec2 w = view_origin + UV * rect_size / zoom; // world, in tiles
	vec2 cw = w / cell;
	vec2 c = floor(cw);

	// The most common terrain among nine points spread over the cell.
	int ids[9];
	for (int j = 0; j < 3; j++) {
		for (int i = 0; i < 3; i++) {
			ids[j * 3 + i] = tile_at((c + (vec2(float(i), float(j)) + 0.5) / 3.0) * cell);
		}
	}
	int best = ids[4];
	int best_n = 0;
	for (int a = 0; a < 9; a++) {
		if (!show_roads && ids[a] == road_id) continue;
		int n = 0;
		for (int b = 0; b < 9; b++) {
			n += int(ids[b] == ids[a]);
		}
		// Ties go to the middle of the cell, then to whichever came first.
		if (n > best_n || (n == best_n && ids[a] == ids[4])) {
			best = ids[a];
			best_n = n;
		}
	}

	// A road counts if it crosses most of the cell, not if it clips a corner.
	float road_tiles = texelFetch(roads, ivec2(c - floor(tiles_origin / cell)), 0).r * 255.0;
	if (!show_roads && best == road_id) {
		best = plain_id;
	} else if (best != UNKNOWN && show_roads && road_tiles >= cell * 0.75) {
		bool keep = false;
		for (int k = 0; k < 4; k++) {
			keep = keep || best == keep_over_road[k];
		}
		if (!keep) {
			best = road_id;
		}
	}

	if (best == UNKNOWN) {
		COLOR = vec4(0.0, 0.0, 0.0, 1.0);
	} else {
		ivec2 px = ivec2(floor(fract(cw) * ART));
		COLOR = texelFetch(art, ivec2(best * int(ART) + px.x, px.y), 0);
	}
}
