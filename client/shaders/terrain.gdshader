// Ground of the first-person arena: each 2x2 m quad shows one overworld tile
// from the pixel-art atlas. The tiles have black backgrounds (they were drawn
// for a black Ultima-style screen), so black pixels are replaced with a dark
// shade of the terrain's map colour, passed in the vertex colour. Vertex alpha
// marks radioactive ground, which glows and pulses.
shader_type spatial;

uniform sampler2D atlas : source_color, filter_nearest;

void fragment() {
	vec4 t = texture(atlas, UV);
	float is_black = step(t.r + t.g + t.b, 0.06);
	vec3 base = COLOR.rgb * 0.5;
	// Tone the pixel art towards the terrain colour so busy tiles don't shout.
	ALBEDO = mix(mix(base, t.rgb, 0.55), base, is_black);
	ROUGHNESS = 0.95;
	EMISSION = vec3(0.2, 1.0, 0.2) * COLOR.a * (0.35 + 0.25 * sin(TIME * 3.0));
}
