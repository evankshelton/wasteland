// Which overworld tile each point of the first-person arena belongs to, and
// how the four nearest tiles blend there. Shared by the ground and the water
// so their borders line up exactly.

uniform sampler2D cells : filter_nearest, repeat_disable; // tile id per arena cell, R8
uniform sampler2D breakup : filter_linear, repeat_enable; // seamless noise, three channels
uniform float cell_size = 12.0;
uniform float radius = 8.0; // cells from the centre to the edge of the arena

float tile_id(vec2 cell) {
	float n = 2.0 * radius + 1.0;
	vec2 uv = clamp((cell + radius + 0.5) / n, vec2(0.5 / n), vec2(1.0 - 0.5 / n));
	return floor(texture(cells, uv).r * 255.0 + 0.5);
}

// The four nearest cells' tile ids (x: c0, y: +x, z: +y, w: +x+y) and the
// blend weights between them: solid near a cell's middle, mixing towards its
// edges, with the borders wobbled by noise so they meander.
void arena_cells(vec2 p, out vec4 ids, out vec2 f) {
	vec2 wobble = (texture(breakup, p / 45.0).rg - 0.5) * cell_size * 0.7;
	vec2 g = (p + wobble) / cell_size; // cell centres sit on whole numbers
	vec2 c0 = floor(g);
	f = smoothstep(0.2, 0.8, g - c0);
	ids = vec4(tile_id(c0), tile_id(c0 + vec2(1.0, 0.0)), tile_id(c0 + vec2(0.0, 1.0)), tile_id(c0 + vec2(1.0, 1.0)));
}

// How much of a point is the given tile type, 0..1.
float arena_weight(vec4 ids, vec2 f, float id) {
	return mix(mix(float(ids.x == id), float(ids.y == id), f.x), mix(float(ids.z == id), float(ids.w == id), f.x), f.y);
}
