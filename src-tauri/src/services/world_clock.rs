//! Home clock and world-clock board. Times are computed from IANA zones on every tick
//! (chrono-tz), never from stored offsets, so daylight-saving changes are always correct.

use chrono::{DateTime, Datelike, Offset, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::Serialize;

use super::settings::City;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HomeTime {
    pub tz: String,
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    pub weekday: String,
    pub iso_week: u32,
    pub utc_offset_minutes: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CityTime {
    pub name: String,
    pub code: String,
    pub tz: String,
    pub time: String,
    pub diff_minutes: i32,
    pub diff_label: String,
    pub day_shift: i32,
    pub valid: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClockSnapshot {
    pub epoch_ms: i64,
    pub home: HomeTime,
    pub cities: Vec<CityTime>,
}

/// The Windows time zone as an IANA name, or UTC if it cannot be mapped.
pub fn system_time_zone() -> String {
    iana_time_zone::get_timezone().ok().filter(|z| z.parse::<Tz>().is_ok()).unwrap_or_else(|| "UTC".to_string())
}

pub fn resolve_home(home: Option<&str>) -> Tz {
    home.and_then(|z| z.parse::<Tz>().ok()).or_else(|| system_time_zone().parse::<Tz>().ok()).unwrap_or(chrono_tz::UTC)
}

pub fn offset_minutes(tz: Tz, at: DateTime<Utc>) -> i32 {
    tz.offset_from_utc_datetime(&at.naive_utc()).fix().local_minus_utc() / 60
}

/// `+1H`, `-7H`, `+5H30`, `-3H30`, `±0H`.
pub fn diff_label(minutes: i32) -> String {
    if minutes == 0 {
        return "±0H".to_string();
    }
    let sign = if minutes < 0 { '-' } else { '+' };
    let a = minutes.unsigned_abs();
    let (h, m) = (a / 60, a % 60);
    if m == 0 {
        format!("{sign}{h}H")
    } else {
        format!("{sign}{h}H{m:02}")
    }
}

pub fn home_time(tz: Tz, at: DateTime<Utc>) -> HomeTime {
    let l = at.with_timezone(&tz);
    HomeTime {
        tz: tz.name().to_string(),
        year: l.year(),
        month: l.month(),
        day: l.day(),
        hour: l.hour(),
        minute: l.minute(),
        second: l.second(),
        weekday: l.format("%a").to_string().to_uppercase(),
        iso_week: l.iso_week().week(),
        utc_offset_minutes: offset_minutes(tz, at),
    }
}

pub fn city_time(city: &City, home: Tz, at: DateTime<Utc>) -> CityTime {
    let Ok(tz) = city.tz.parse::<Tz>() else {
        return CityTime {
            name: city.name.clone(),
            code: city.code.clone(),
            tz: city.tz.clone(),
            time: "--:--".into(),
            diff_minutes: 0,
            diff_label: "—".into(),
            day_shift: 0,
            valid: false,
        };
    };
    let local = at.with_timezone(&tz);
    let home_local = at.with_timezone(&home);
    let diff = offset_minutes(tz, at) - offset_minutes(home, at);
    let day_shift = (local.date_naive() - home_local.date_naive()).num_days().clamp(-1, 1) as i32;
    CityTime {
        name: city.name.clone(),
        code: city.code.clone(),
        tz: city.tz.clone(),
        time: format!("{:02}:{:02}", local.hour(), local.minute()),
        diff_minutes: diff,
        diff_label: diff_label(diff),
        day_shift,
        valid: true,
    }
}

pub fn snapshot(at: DateTime<Utc>, home: Option<&str>, cities: &[City]) -> ClockSnapshot {
    let home_tz = resolve_home(home);
    ClockSnapshot {
        epoch_ms: at.timestamp_millis(),
        home: home_time(home_tz, at),
        cities: cities.iter().map(|c| city_time(c, home_tz, at)).collect(),
    }
}

/// Every IANA zone name chrono-tz knows, for the "add city" and "home zone" pickers.
pub fn all_zones() -> Vec<String> {
    chrono_tz::TZ_VARIANTS.iter().map(|z| z.name().to_string()).filter(|n| n.contains('/') || n == "UTC").collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }
    fn city(tz: &str) -> City {
        City { name: tz.to_uppercase(), code: "XXX".into(), tz: tz.into() }
    }

    #[test]
    fn labels() {
        assert_eq!(diff_label(0), "±0H");
        assert_eq!(diff_label(60), "+1H");
        assert_eq!(diff_label(-420), "-7H");
        assert_eq!(diff_label(330), "+5H30");
        assert_eq!(diff_label(-210), "-3H30");
        assert_eq!(diff_label(345), "+5H45");
    }

    #[test]
    fn reference_screen_values_singapore_home() {
        // The design's sample: 12:43 on Tue 06 Oct 2026 in Singapore.
        let t = at("2026-10-06T04:43:00Z");
        let home: Tz = "Asia/Singapore".parse().unwrap();
        let h = home_time(home, t);
        assert_eq!((h.hour, h.minute, h.weekday.as_str(), h.iso_week, h.utc_offset_minutes), (12, 43, "TUE", 41, 480));
        let lon = city_time(&city("Europe/London"), home, t);
        assert_eq!((lon.time.as_str(), lon.diff_label.as_str()), ("05:43", "-7H")); // BST
        let ny = city_time(&city("America/New_York"), home, t);
        assert_eq!((ny.time.as_str(), ny.diff_label.as_str()), ("00:43", "-12H"));
        let syd = city_time(&city("Australia/Sydney"), home, t);
        assert_eq!((syd.time.as_str(), syd.diff_label.as_str()), ("15:43", "+3H")); // AEDT began 4 Oct 2026
        let dxb = city_time(&city("Asia/Dubai"), home, t);
        assert_eq!((dxb.time.as_str(), dxb.diff_label.as_str()), ("08:43", "-4H"));
        let mnl = city_time(&city("Asia/Manila"), home, t);
        assert_eq!(mnl.diff_label, "±0H");
    }

    #[test]
    fn london_dst_transition() {
        let home: Tz = "UTC".parse().unwrap();
        let c = city("Europe/London");
        // 2026: BST ends 25 Oct 01:00 UTC.
        let before = city_time(&c, home, at("2026-10-25T00:59:00Z"));
        let after = city_time(&c, home, at("2026-10-25T01:00:00Z"));
        assert_eq!((before.time.as_str(), before.diff_minutes), ("01:59", 60));
        assert_eq!((after.time.as_str(), after.diff_minutes), ("01:00", 0));
        // BST starts 29 Mar 2026 01:00 UTC.
        let spring = city_time(&c, home, at("2026-03-29T01:00:00Z"));
        assert_eq!((spring.time.as_str(), spring.diff_minutes), ("02:00", 60));
    }

    #[test]
    fn diff_changes_when_only_one_side_observes_dst() {
        let manila: Tz = "Asia/Manila".parse().unwrap();
        let ny = city("America/New_York");
        // Summer: EDT (UTC-4) vs PHT (UTC+8) = -12H; winter: EST (UTC-5) = -13H.
        assert_eq!(city_time(&ny, manila, at("2026-07-01T00:00:00Z")).diff_label, "-12H");
        assert_eq!(city_time(&ny, manila, at("2026-12-01T00:00:00Z")).diff_label, "-13H");
        // US DST 2026 ends 1 Nov 06:00 UTC.
        assert_eq!(city_time(&ny, manila, at("2026-11-01T05:59:00Z")).diff_label, "-12H");
        assert_eq!(city_time(&ny, manila, at("2026-11-01T06:00:00Z")).diff_label, "-13H");
    }

    #[test]
    fn southern_hemisphere_dst() {
        let utc: Tz = "UTC".parse().unwrap();
        let syd = city("Australia/Sydney");
        assert_eq!(city_time(&syd, utc, at("2026-07-01T00:00:00Z")).diff_label, "+10H");
        assert_eq!(city_time(&syd, utc, at("2026-12-01T00:00:00Z")).diff_label, "+11H");
    }

    #[test]
    fn half_and_quarter_hour_zones() {
        let utc: Tz = "UTC".parse().unwrap();
        let t = at("2026-01-15T12:00:00Z");
        assert_eq!(city_time(&city("Asia/Kolkata"), utc, t).diff_label, "+5H30");
        assert_eq!(city_time(&city("Asia/Kathmandu"), utc, t).diff_label, "+5H45");
        assert_eq!(city_time(&city("America/St_Johns"), utc, t).diff_label, "-3H30");
    }

    #[test]
    fn day_shift_across_midnight() {
        let manila: Tz = "Asia/Manila".parse().unwrap();
        // 01:00 in Manila = previous day in New York.
        let t = at("2026-06-14T17:00:00Z");
        assert_eq!(city_time(&city("America/New_York"), manila, t).day_shift, -1);
        assert_eq!(city_time(&city("Pacific/Kiritimati"), manila, t).day_shift, 0);
        let t2 = at("2026-06-14T15:30:00Z"); // 23:30 Manila, 03:30+1 Auckland
        assert_eq!(city_time(&city("Pacific/Auckland"), manila, t2).day_shift, 1);
    }

    #[test]
    fn invalid_zone_is_marked_not_panicking() {
        let c = city_time(&city("Nowhere/Land"), chrono_tz::UTC, Utc::now());
        assert!(!c.valid);
        assert_eq!(c.time, "--:--");
    }

    #[test]
    fn iso_week_edges() {
        let utc: Tz = "UTC".parse().unwrap();
        assert_eq!(home_time(utc, at("2026-01-01T00:00:00Z")).iso_week, 1);
        assert_eq!(home_time(utc, at("2027-01-01T00:00:00Z")).iso_week, 53);
    }

    #[test]
    fn zone_list_contains_defaults() {
        let z = all_zones();
        for n in ["Asia/Manila", "Europe/London", "America/New_York", "Asia/Tokyo", "Australia/Sydney", "Asia/Dubai", "UTC"] {
            assert!(z.iter().any(|x| x == n), "{n}");
        }
    }
}
