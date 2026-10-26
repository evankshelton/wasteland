// Ground of the first-person arena. Each overworld tile is a CELL x CELL patch
// of terrain, but instead of hard-edged squares every point blends the four
// nearest tiles' pixel art (see arena_cells.gdshaderinc): solid near a tile's
// middle, mixing towards its edges along meandering borders. Black pixels in
// the art (it was drawn for a black Ultima-style screen) become a dark shade
// of the terrain's map colour. Hot zones glow.
shader_type spatial;

#include "res://shaders/arena_cells.gdshaderinc"

uniform sampler2D atlas : source_color, filter_nearest_mipmap, repeat_disable; // tiles.png
uniform sampler2D palette : source_color, filter_nearest, repeat_disable; // map colour per tile id
uniform float tile_count = 28.0;
uniform float texture_metres = 2.0; // the pixel art repeats this often
uniform float glow_id = 10.0; // radiation

varying vec3 world_pos;

void vertex() {
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

vec3 tile_colour(float id, vec2 tex, vec2 ddx, vec2 ddy) {
	vec2 uv = vec2((id + fract(tex.x)) / tile_count, fract(tex.y));
	vec2 scale = vec2(1.0 / tile_count, 1.0);
	vec4 t = textureGrad(atlas, uv, ddx * scale, ddy * scale);
	vec3 base = texture(palette, vec2((id + 0.5) / tile_count, 0.5)).rgb * 0.5;
	float black = 1.0 - smoothstep(0.03, 0.12, t.r + t.g + t.b);
	// Tone the pixel art towards the terrain colour so busy tiles don't shout.
	return mix(mix(base, t.rgb, 0.55), base, black);
}

void fragment() {
	vec2 p = world_pos.xz;
	vec2 tex = p / texture_metres;
	vec2 ddx = dFdx(tex);
	vec2 ddy = dFdy(tex);

	vec4 ids;
	vec2 f;
	arena_cells(p, ids, f);
	vec3 col = mix(
		mix(tile_colour(ids.x, tex, ddx, ddy), tile_colour(ids.y, tex, ddx, ddy), f.x),
		mix(tile_colour(ids.z, tex, ddx, ddy), tile_colour(ids.w, tex, ddx, ddy), f.x), f.y);

	// Broad patches of lighter and darker ground.
	float shade = texture(breakup, p / 140.0 + vec2(0.37, 0.71)).b;
	ALBEDO = col * (0.82 + 0.36 * shade);
	ROUGHNESS = 0.95;
	EMISSION = vec3(0.2, 1.0, 0.2) * arena_weight(ids, f, glow_id) * (0.35 + 0.25 * sin(TIME * 3.0));
}
