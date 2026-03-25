# Using CocoNot for Other Allergies

CocoNot can be reconfigured for any allergen without code changes — just set environment variables.

## Configuration

Set `ALLERGEN_KEYWORDS` to a comma-separated list of keywords to detect in ingredient lists:

```bash
docker run -d \
  -p 8080:8080 \
  -v pgdata:/var/lib/postgresql/data \
  -v offdata:/data \
  -e ALLERGEN_KEYWORDS=peanut,arachis\ hypogaea,groundnut \
  ghcr.io/<owner>/coconutfree:latest
```

## Examples

**Peanuts:**
```
ALLERGEN_KEYWORDS=peanut,arachis hypogaea,groundnut
```

**Soy:**
```
ALLERGEN_KEYWORDS=soy,soya,soybean,glycine max
```

**Gluten:**
```
ALLERGEN_KEYWORDS=wheat,gluten,barley,rye,spelt,kamut,triticale
```

**Tree nuts:**
```
ALLERGEN_KEYWORDS=almond,cashew,walnut,pecan,pistachio,macadamia,hazelnut,brazil nut
```

## Country Filter

By default, only US products are ingested. To change:

- **Specific country:** `INGEST_COUNTRIES=en:france`
- **All countries:** `INGEST_COUNTRIES=-`

Country tags use the OFF format: `en:united-states`, `en:france`, `en:germany`, etc.

## Frontend Branding

If you want to change the user-facing branding:

- **App title:** `frontend/src/components/Nav.tsx` — change "CocoNot" text
- **Splash screen:** `frontend/src/components/SplashScreen.tsx` — change emoji and app name
- **Favicon:** `frontend/public/favicon.svg` — replace the coconut icon
- **PWA manifest:** `frontend/vite.config.ts` — update `name`, `short_name`, `description`

## Note on DB Column Names

The database column `contains_coconut` retains its name regardless of which allergen you configure. It means "contains the configured allergen." This is a cosmetic issue only — the detection logic is fully driven by `ALLERGEN_KEYWORDS`.
