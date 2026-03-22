Name:           vinyl
Version:        1.0.0
Release:        1%{?dist}
Summary:        Vinyl — a private YouTube audio player
License:        MIT
URL:            https://github.com/zorncbllr/vinyl-electron

%define _build_id_links none
%define debug_package %{nil}
%undefine __brp_mangle_shebangs

%description
Vinyl is a private YouTube audio player built with Electron.

%install
mkdir -p %{buildroot}/opt/Vinyl
cp -a %{_appdir}/* %{buildroot}/opt/Vinyl/
mkdir -p %{buildroot}/usr/bin
ln -sf /opt/Vinyl/vinyl %{buildroot}/usr/bin/vinyl
mkdir -p %{buildroot}/usr/share/applications
cat > %{buildroot}/usr/share/applications/vinyl.desktop << 'EOF'
[Desktop Entry]
Name=Vinyl
Comment=Private YouTube audio player
Exec=/opt/Vinyl/vinyl --no-sandbox %U
Icon=vinyl
Terminal=false
Type=Application
Categories=Audio;Music;Player;
EOF
for size in 16 32 48 64 128 256 512; do
  mkdir -p %{buildroot}/usr/share/icons/hicolor/${size}x${size}/apps
  cp %{_iconsdir}/${size}x${size}.png %{buildroot}/usr/share/icons/hicolor/${size}x${size}/apps/vinyl.png
done

%files
/opt/Vinyl
/usr/bin/vinyl
/usr/share/applications/vinyl.desktop
/usr/share/icons/hicolor/*/apps/vinyl.png

%post
update-desktop-database /usr/share/applications &>/dev/null || :
gtk-update-icon-cache /usr/share/icons/hicolor &>/dev/null || :

%postun
update-desktop-database /usr/share/applications &>/dev/null || :
gtk-update-icon-cache /usr/share/icons/hicolor &>/dev/null || :
